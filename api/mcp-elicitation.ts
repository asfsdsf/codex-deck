export interface CodexElicitationRequest {
  requestId: string;
  threadId: string;
  turnId: string | null;
  serverName: string;
  mode:
    | "form"
    | "openai/form"
    | "openaiForm"
    | "url"
    | "openai/userVerification";
  message: string;
  requestedSchema?: Record<string, unknown>;
  url?: string;
  elicitationId?: string;
}

export interface CodexElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown> | null;
}

export interface ElicitationField {
  name: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  title: string;
  description?: string;
  required: boolean;
  options?: { value: string; label: string }[];
  schema: Record<string, unknown>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function elicitationUrl(value?: string): string | null {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function parseElicitationRequest(
  requestId: string,
  value: unknown,
): CodexElicitationRequest | null {
  if (
    !record(value) ||
    typeof value.threadId !== "string" ||
    !value.threadId.trim() ||
    typeof value.serverName !== "string"
  )
    return null;
  const mode = value.mode;
  if (
    ![
      "form",
      "openai/form",
      "openaiForm",
      "url",
      "openai/userVerification",
    ].includes(String(mode))
  )
    return null;
  return {
    requestId,
    threadId: value.threadId,
    turnId: typeof value.turnId === "string" ? value.turnId : null,
    serverName: value.serverName,
    mode: mode as CodexElicitationRequest["mode"],
    message:
      mode === "openai/userVerification"
        ? [value.title, value.description]
            .filter((v) => typeof v === "string")
            .join("\n\n")
        : typeof value.message === "string"
          ? value.message
          : "",
    ...(record(value.requestedSchema)
      ? { requestedSchema: value.requestedSchema }
      : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.elicitationId === "string"
      ? { elicitationId: value.elicitationId }
      : {}),
  };
}

function options(schema: Record<string, unknown>): ElicitationField["options"] {
  const choiceRules = ["enum", "oneOf", "anyOf"].filter(
    (key) => schema[key] !== undefined,
  );
  if (choiceRules.length > 1)
    throw new Error("Unsupported combined enum validation rules.");
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((v) => typeof v === "string")
  )
    return schema.enum.map((value, i) => ({
      value: value as string,
      label:
        Array.isArray(schema.enumNames) &&
        typeof schema.enumNames[i] === "string"
          ? (schema.enumNames[i] as string)
          : (value as string),
    }));
  const variants = schema.oneOf ?? schema.anyOf;
  if (
    Array.isArray(variants) &&
    variants.length > 0 &&
    variants.every(
      (v) =>
        record(v) &&
        typeof v.const === "string" &&
        Object.keys(v).every((key) =>
          ["const", "title", "description"].includes(key),
        ),
    )
  )
    return variants.map((v) => ({
      value: v.const as string,
      label: typeof v.title === "string" ? v.title : (v.const as string),
    }));
  return undefined;
}

/** MCP forms have primitive fields and enum arrays. Unknown schemas stay declineable. */
export function elicitationFields(
  schema?: Record<string, unknown>,
): ElicitationField[] {
  if (!schema || schema.type !== "object" || !record(schema.properties))
    throw new Error("This form schema is not supported.");
  const topKeys = new Set([
    "type",
    "properties",
    "required",
    "$schema",
    "title",
    "description",
    "additionalProperties",
  ]);
  if (Object.keys(schema).some((k) => !topKeys.has(k)))
    throw new Error("This form uses unsupported validation rules.");
  if (schema.required !== undefined && !Array.isArray(schema.required))
    throw new Error("Invalid required form fields.");
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (
    required.some(
      (k) =>
        typeof k !== "string" ||
        !Object.prototype.hasOwnProperty.call(schema.properties, k),
    )
  )
    throw new Error("Invalid required form fields.");
  return Object.entries(schema.properties).map(([name, field]) => {
    if (
      !record(field) ||
      !["string", "number", "integer", "boolean", "array"].includes(
        String(field.type),
      )
    )
      throw new Error(`Unsupported field: ${name}`);
    const rules: Record<string, string[]> = {
      string: [
        "minLength",
        "maxLength",
        "format",
        "enum",
        "enumNames",
        "oneOf",
        "anyOf",
      ],
      number: ["minimum", "maximum"],
      integer: ["minimum", "maximum"],
      boolean: [],
      array: ["items", "minItems", "maxItems"],
    };
    const allowed = new Set([
      "type",
      "title",
      "description",
      "default",
      ...rules[String(field.type)],
    ]);
    if (Object.keys(field).some((k) => !allowed.has(k)))
      throw new Error(`Unsupported validation for ${name}`);
    if (
      field.type === "array" &&
      record(field.items) &&
      ((field.items.type !== undefined && field.items.type !== "string") ||
        Object.keys(field.items).some(
          (key) =>
            ![
              "type",
              "title",
              "description",
              "enum",
              "enumNames",
              "oneOf",
              "anyOf",
            ].includes(key),
        ))
    )
      throw new Error(`Unsupported array validation for ${name}`);
    const choices =
      field.type === "array"
        ? record(field.items)
          ? options(field.items)
          : undefined
        : options(field);
    if (field.type === "array" && !choices)
      throw new Error(`Unsupported array field: ${name}`);
    if ((field.enum || field.oneOf || field.anyOf) && !choices)
      throw new Error(`Invalid choices for ${name}`);
    if (
      field.format &&
      !["email", "uri", "date", "date-time"].includes(String(field.format))
    )
      throw new Error(`Unsupported format for ${name}`);
    return {
      name,
      type: field.type as ElicitationField["type"],
      title: typeof field.title === "string" ? field.title : name,
      description:
        typeof field.description === "string" ? field.description : undefined,
      required: required.includes(name),
      options: choices,
      schema: field,
    };
  });
}

/** Preserve explicit strings, including empty enum values; blank numbers are absent. */
export function elicitationFormContent(
  fields: ElicitationField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = Object.prototype.hasOwnProperty.call(values, field.name)
        ? values[field.name]
        : field.required && field.type === "string" && !field.options
          ? ""
          : undefined;
      if (value === undefined) return [];
      if (field.type === "number" || field.type === "integer")
        return value === "" ? [] : [[field.name, Number(value)]];
      return [[field.name, value]];
    }),
  );
}

export function validateElicitationResponse(
  request: CodexElicitationRequest,
  value: unknown,
): asserts value is CodexElicitationResponse {
  const fail = (message: string): never => {
    throw new Error(`Invalid elicitation response: ${message}`);
  };
  if (
    !record(value) ||
    !["accept", "decline", "cancel"].includes(String(value.action))
  )
    fail("action must be accept, decline, or cancel");
  const response = value as unknown as CodexElicitationResponse;
  if (response.action !== "accept") {
    if (response.content != null)
      fail("decline/cancel must not include content");
    return;
  }
  if (request.mode === "openai/userVerification")
    fail("native device verification is unavailable in this browser client");
  if (request.mode === "url") {
    if (!elicitationUrl(request.url))
      fail("authorization URL is not supported");
    if (response.content != null)
      fail("URL acceptance must not include content");
    return;
  }
  let fields: ElicitationField[] = [];
  try {
    fields = elicitationFields(request.requestedSchema);
  } catch (error) {
    fail(error instanceof Error ? error.message : "unsupported form");
  }
  const content = response.content;
  if (!record(content)) fail("form content must be an object");
  const data = content as Record<string, unknown>;
  if (Object.keys(data).some((k) => !fields.some((f) => f.name === k)))
    fail("unknown form field");
  for (const field of fields) {
    const val = Object.prototype.hasOwnProperty.call(data, field.name)
      ? data[field.name]
      : undefined;
    if (val === undefined) {
      if (field.required) fail(`${field.title} is required`);
      continue;
    }
    const schema = field.schema;
    const invalid = () => fail(`${field.title} is invalid`);
    if (field.type === "string") {
      if (typeof val !== "string") invalid();
      const text = val as string;
      const length = [...text].length;
      if (
        (typeof schema.minLength === "number" && length < schema.minLength) ||
        (typeof schema.maxLength === "number" && length > schema.maxLength)
      )
        invalid();
      if (field.options && !field.options.some((o) => o.value === text))
        invalid();
      if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
        invalid();
      if (schema.format === "uri") {
        try {
          new URL(text);
        } catch {
          invalid();
        }
      }
      if (
        schema.format === "date" &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
          !Number.isFinite(Date.parse(text)) ||
          new Date(text).toISOString().slice(0, 10) !== text)
      )
        invalid();
      if (
        schema.format === "date-time" &&
        (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ||
          !Number.isFinite(Date.parse(text)))
      )
        invalid();
    } else if (field.type === "number" || field.type === "integer") {
      if (
        typeof val !== "number" ||
        !Number.isFinite(val) ||
        (field.type === "integer" && !Number.isInteger(val))
      )
        invalid();
      if (
        (typeof schema.minimum === "number" &&
          (val as number) < schema.minimum) ||
        (typeof schema.maximum === "number" && (val as number) > schema.maximum)
      )
        invalid();
    } else if (field.type === "boolean") {
      if (typeof val !== "boolean") invalid();
    } else {
      if (
        !Array.isArray(val) ||
        val.some(
          (v) =>
            typeof v !== "string" || !field.options?.some((o) => o.value === v),
        ) ||
        new Set(val).size !== val.length
      )
        invalid();
      const list = val as unknown[];
      if (
        (typeof schema.minItems === "number" &&
          list.length < schema.minItems) ||
        (typeof schema.maxItems === "number" && list.length > schema.maxItems)
      )
        invalid();
    }
  }
}
