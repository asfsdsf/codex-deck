/** Composer-side validation for a final-answer JSON schema (`outputSchema`). */
export type OutputSchemaDraftResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export const MAX_OUTPUT_SCHEMA_CHARS = 64 * 1024;

export function parseOutputSchemaDraft(text: string): OutputSchemaDraftResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "Paste a JSON Schema object." };
  }
  if (trimmed.length > MAX_OUTPUT_SCHEMA_CHARS) {
    return { ok: false, error: "The schema is larger than 64 KB." };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "The schema must be a JSON object." };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** Short label for the attached-schema chip, e.g. "object · 3 properties". */
export function summarizeOutputSchema(schema: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof schema.title === "string" && schema.title.trim()) {
    parts.push(schema.title.trim());
  }
  if (typeof schema.type === "string") {
    parts.push(schema.type);
  }
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    const count = Object.keys(properties).length;
    parts.push(`${count} ${count === 1 ? "property" : "properties"}`);
  }
  return parts.join(" · ") || "custom schema";
}

export const OUTPUT_SCHEMA_RUNNING_TURN_ERROR =
  "A JSON output schema applies to a new turn. Wait for the running turn to finish or use Interrupt & send.";
