export interface CodexBackgroundTerminal {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
}
export function parseBackgroundTerminal(
  value: unknown,
): CodexBackgroundTerminal {
  const record = value as Record<string, unknown> | null;
  if (
    !record ||
    ["itemId", "processId", "command", "cwd"].some(
      (key) => typeof record[key] !== "string",
    ) ||
    !record.processId
  )
    throw new Error("Invalid background terminal response");
  const metric = (key: string) =>
    typeof record[key] === "number" &&
    Number.isFinite(record[key]) &&
    record[key] >= 0
      ? (record[key] as number)
      : null;
  return {
    itemId: record.itemId as string,
    processId: record.processId as string,
    command: record.command as string,
    cwd: record.cwd as string,
    osPid: metric("osPid"),
    cpuPercent: metric("cpuPercent"),
    rssKb: metric("rssKb"),
  };
}
