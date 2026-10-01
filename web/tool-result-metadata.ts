export interface ToolResultMetadata {
  durationMs?: number;
  exitCode?: number;
  outputTokens?: number;
  truncated?: boolean;
}

/** Read the tool envelope, without mistaking command stdout for metadata. */
export function getToolResultMetadata(content: unknown): ToolResultMetadata {
  let value = content;
  if (typeof value === "string" && value.trimStart().startsWith("{")) {
    try {
      value = JSON.parse(value);
    } catch {
      /* Plain tool output. */
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const result: ToolResultMetadata = {};
    const number = (key: string) =>
      typeof record[key] === "number" && Number.isFinite(record[key])
        ? (record[key] as number)
        : undefined;
    const seconds = number("wall_time_seconds");
    const milliseconds = number("duration_ms");
    if (seconds !== undefined && seconds >= 0)
      result.durationMs = seconds * 1000;
    else if (milliseconds !== undefined && milliseconds >= 0)
      result.durationMs = milliseconds;
    const exitCode = number("exit_code");
    if (exitCode !== undefined && Number.isInteger(exitCode))
      result.exitCode = exitCode;
    const outputTokens = number("original_token_count");
    if (outputTokens !== undefined && outputTokens >= 0)
      result.outputTokens = outputTokens;
    if (typeof record.truncated === "boolean")
      result.truncated = record.truncated;
    return result;
  }
  if (typeof value !== "string") return {};
  // Codex shell tools place their measurements before Output / Final output.
  const prefix = value.slice(0, 4096);
  if (!/^(?:Chunk ID:|Wall time:)/.test(prefix)) return {};
  const header = prefix.split(/\n(?:Final output|Output):(?:\n|$)/, 1)[0] ?? "";
  const duration = /^Wall time:\s*([\d.]+)\s*seconds\s*$/m.exec(header);
  const exit = /^Process exited with code\s+(-?\d+)\s*$/m.exec(header);
  const tokens = /^Original token count:\s*(\d+)\s*$/m.exec(header);
  return {
    ...(duration && Number.isFinite(Number(duration[1]))
      ? { durationMs: Number(duration[1]) * 1000 }
      : {}),
    ...(exit ? { exitCode: Number(exit[1]) } : {}),
    ...(tokens ? { outputTokens: Number(tokens[1]) } : {}),
    ...(/^(?:Warning: )?(?:truncated output|output (?:was )?truncated)\b/im.test(
      header,
    )
      ? { truncated: true }
      : {}),
  };
}
