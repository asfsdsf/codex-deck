export interface NormalizedToolUse {
  name: string;
  input: Record<string, unknown>;
}

interface ParsedStringLiteral {
  value: string;
  end: number;
}

interface ParsedLiteral {
  value: unknown;
  end: number;
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return !!character && /[A-Za-z0-9_$]/.test(character);
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

function parseStringLiteral(
  source: string,
  start: number,
): ParsedStringLiteral | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") {
    return null;
  }

  let value = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === quote) {
      return { value, end: index + 1 };
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      return null;
    }
    if (character !== "\\") {
      value += character;
      continue;
    }

    index += 1;
    const escaped = source[index];
    if (escaped === undefined) {
      return null;
    }
    if (escaped === "\n") {
      continue;
    }
    if (escaped === "\r") {
      if (source[index + 1] === "\n") {
        index += 1;
      }
      continue;
    }

    const simpleEscapes: Record<string, string> = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "0": "\0",
    };
    if (escaped in simpleEscapes) {
      value += simpleEscapes[escaped];
      continue;
    }

    if (escaped === "x") {
      const digits = source.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(digits)) {
        return null;
      }
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      index += 2;
      continue;
    }

    if (escaped === "u") {
      const bracedMatch = source.slice(index + 1).match(/^\{([0-9A-Fa-f]+)\}/);
      if (bracedMatch) {
        value += String.fromCodePoint(Number.parseInt(bracedMatch[1], 16));
        index += bracedMatch[0].length;
        continue;
      }
      const digits = source.slice(index + 1, index + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(digits)) {
        return null;
      }
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 4;
      continue;
    }

    value += escaped;
  }

  return null;
}

function findCallArgumentStart(raw: string, toolName: string): number | null {
  const marker = `tools.${toolName}`;
  let searchFrom = 0;

  while (searchFrom < raw.length) {
    const markerIndex = raw.indexOf(marker, searchFrom);
    if (markerIndex < 0) {
      return null;
    }
    const before = raw[markerIndex - 1];
    const after = raw[markerIndex + marker.length];
    if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) {
      const openParen = skipWhitespace(raw, markerIndex + marker.length);
      if (raw[openParen] === "(") {
        return skipWhitespace(raw, openParen + 1);
      }
    }
    searchFrom = markerIndex + marker.length;
  }

  return null;
}

function findObjectStringProperty(
  source: string,
  objectStart: number,
  propertyNames: ReadonlySet<string>,
): string | null {
  if (source[objectStart] !== "{") {
    return null;
  }

  let depth = 0;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === '"' || character === "'" || character === "`") {
      const parsed = parseStringLiteral(source, index);
      if (!parsed) {
        return null;
      }
      index = parsed.end - 1;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return null;
      }
      continue;
    }
    if (depth !== 1 || !/[A-Za-z_$]/.test(character)) {
      continue;
    }

    let end = index + 1;
    while (isIdentifierCharacter(source[end])) {
      end += 1;
    }
    const propertyName = source.slice(index, end);
    const colon = skipWhitespace(source, end);
    if (source[colon] !== ":" || !propertyNames.has(propertyName)) {
      index = end - 1;
      continue;
    }
    const valueStart = skipWhitespace(source, colon + 1);
    return parseStringLiteral(source, valueStart)?.value ?? null;
  }

  return null;
}

function parsePrimitiveLiteral(
  source: string,
  start: number,
): ParsedLiteral | null {
  const stringLiteral = parseStringLiteral(source, start);
  if (stringLiteral) {
    return stringLiteral;
  }

  for (const [literal, value] of [
    ["true", true],
    ["false", false],
    ["null", null],
  ] as const) {
    if (
      source.startsWith(literal, start) &&
      !isIdentifierCharacter(source[start + literal.length])
    ) {
      return { value, end: start + literal.length };
    }
  }

  const numberMatch = source
    .slice(start)
    .match(/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
  if (!numberMatch) {
    return null;
  }
  const value = Number(numberMatch[0]);
  return Number.isFinite(value)
    ? { value, end: start + numberMatch[0].length }
    : null;
}

function parseSimpleObjectArgument(
  source: string,
  objectStart: number,
  objectEnd: number,
): Record<string, unknown> | null {
  const input: Record<string, unknown> = {};
  let index = objectStart + 1;

  while (index < objectEnd) {
    index = skipWhitespace(source, index);
    if (index >= objectEnd) {
      return input;
    }

    let propertyName: string;
    const quotedProperty = parseStringLiteral(source, index);
    if (quotedProperty) {
      propertyName = quotedProperty.value;
      index = quotedProperty.end;
    } else {
      const propertyMatch = source.slice(index).match(/^[A-Za-z_$][\w$]*/);
      if (!propertyMatch) {
        return null;
      }
      propertyName = propertyMatch[0];
      index += propertyName.length;
    }

    index = skipWhitespace(source, index);
    if (source[index] !== ":") {
      return null;
    }
    index = skipWhitespace(source, index + 1);

    const parsedValue = parsePrimitiveLiteral(source, index);
    if (!parsedValue) {
      return null;
    }
    input[propertyName] = parsedValue.value;
    index = skipWhitespace(source, parsedValue.end);

    if (index >= objectEnd) {
      return input;
    }
    if (source[index] !== ",") {
      return null;
    }
    index += 1;
  }

  return input;
}

function parseObjectArgument(
  source: string,
  objectStart: number,
): Record<string, unknown> | null {
  if (source[objectStart] !== "{") {
    return null;
  }

  let depth = 0;
  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === '"' || character === "'" || character === "`") {
      const parsed = parseStringLiteral(source, index);
      if (!parsed) {
        return null;
      }
      index = parsed.end - 1;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character !== "}") {
      continue;
    }

    depth -= 1;
    if (depth !== 0) {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(source.slice(objectStart, index + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return parseSimpleObjectArgument(source, objectStart, index);
    }
  }

  return null;
}

function findAssignedString(
  raw: string,
  identifier: string,
  before: number,
): string | null {
  const declaration = new RegExp(
    `(?:const|let|var)\\s+${identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`,
    "g",
  );
  let value: string | null = null;

  for (const match of raw.slice(0, before).matchAll(declaration)) {
    const valueStart = skipWhitespace(
      raw,
      (match.index ?? 0) + match[0].length,
    );
    const parsed = parseStringLiteral(raw, valueStart);
    if (parsed) {
      value = parsed.value;
    }
  }

  return value;
}

function parseApplyPatch(raw: string): NormalizedToolUse | null {
  const argumentStart = findCallArgumentStart(raw, "apply_patch");
  if (argumentStart === null) {
    return null;
  }

  const literal = parseStringLiteral(raw, argumentStart);
  if (literal) {
    return { name: "apply_patch", input: { raw: literal.value } };
  }

  const identifierMatch = raw.slice(argumentStart).match(/^[A-Za-z_$][\w$]*/);
  if (!identifierMatch) {
    return null;
  }
  const patch = findAssignedString(raw, identifierMatch[0], argumentStart);
  return patch === null ? null : { name: "apply_patch", input: { raw: patch } };
}

function parseExecCommand(raw: string): NormalizedToolUse | null {
  const argumentStart = findCallArgumentStart(raw, "exec_command");
  if (argumentStart === null) {
    return null;
  }

  const parsedInput = parseObjectArgument(raw, argumentStart);
  const parsedCommand = parsedInput?.cmd ?? parsedInput?.command;
  if (typeof parsedCommand === "string") {
    return { name: "exec_command", input: parsedInput };
  }

  const command = findObjectStringProperty(
    raw,
    argumentStart,
    new Set(["cmd", "command"]),
  );
  return command === null
    ? null
    : { name: "exec_command", input: { cmd: command } };
}

function parseWriteStdin(raw: string): NormalizedToolUse | null {
  const argumentStart = findCallArgumentStart(raw, "write_stdin");
  if (argumentStart === null) {
    return null;
  }

  const parsedInput = parseObjectArgument(raw, argumentStart);
  const sessionId = parsedInput?.session_id;
  if (
    !parsedInput ||
    (typeof sessionId !== "number" && typeof sessionId !== "string") ||
    typeof parsedInput.chars !== "string"
  ) {
    return null;
  }

  return { name: "write_stdin", input: parsedInput };
}

export function normalizeToolUse(
  toolName: string | null | undefined,
  input: Record<string, unknown>,
): NormalizedToolUse {
  const name = (toolName || "").toLowerCase();
  if (name !== "exec" || typeof input.raw !== "string") {
    return { name: toolName || "", input };
  }

  return (
    parseApplyPatch(input.raw) ??
    parseExecCommand(input.raw) ??
    parseWriteStdin(input.raw) ?? {
      name: toolName || "",
      input,
    }
  );
}
