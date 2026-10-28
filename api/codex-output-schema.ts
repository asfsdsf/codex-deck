/**
 * Final-answer JSON schema for a turn (`outputSchema` on `turn/start`,
 * like `codex exec --output-schema`). Only a JSON object is accepted.
 */
export const MAX_OUTPUT_SCHEMA_BYTES = 64 * 1024;

export type OutputSchemaParseResult =
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string };

export function parseOutputSchemaInput(
  value: unknown,
): OutputSchemaParseResult {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "outputSchema must be a JSON object" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { ok: false, error: "outputSchema must be a JSON object" };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_OUTPUT_SCHEMA_BYTES) {
    return { ok: false, error: "outputSchema is too large" };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
