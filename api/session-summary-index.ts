import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { plainRolloutPath } from "./rollout-files";

const execFileAsync = promisify(execFile);

export interface SessionSummary {
  id: string;
  path: string;
  cwd: string;
  createdAt: number;
  recencyAt: number;
  archivedAt: number;
  display: string;
}

/** Optional read-only acceleration. Rollouts remain the fallback/source of truth. */
export async function readSessionSummaryIndex(
  dbPath: string,
): Promise<Map<string, SessionSummary>> {
  const result = new Map<string, SessionSummary>();
  const query = async (sql: string) => {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", dbPath, sql],
      { timeout: 2000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    return JSON.parse(stdout || "[]") as Record<string, unknown>[];
  };
  try {
    const columns = new Set(
      (await query("PRAGMA table_info(threads)")).map((row) => row.name),
    );
    if (!["id", "rollout_path", "cwd"].every((column) => columns.has(column)))
      return result;
    // Only select known column names; older Codex schemas need not have ms fields.
    const optional = [
      "created_at",
      "created_at_ms",
      "recency_at",
      "recency_at_ms",
      "updated_at",
      "updated_at_ms",
      "archived",
      "archived_at",
      "first_user_message",
      "preview",
      "title",
    ];
    const rows = await query(
      `SELECT id, rollout_path, cwd, ${optional.map((column) => (columns.has(column) ? column : `NULL AS ${column}`)).join(", ")} FROM threads`,
    );
    const time = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value)
        ? value > 0 && value < 1e12
          ? value * 1000
          : value
        : 0;
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.rollout_path !== "string" ||
        typeof row.cwd !== "string"
      )
        continue;
      const display = [row.first_user_message, row.preview, row.title].find(
        (value) => typeof value === "string" && value.trim(),
      ) as string | undefined;
      const summary = {
        id: row.id,
        path: row.rollout_path,
        cwd: row.cwd,
        createdAt: time(row.created_at_ms) || time(row.created_at),
        recencyAt:
          time(row.recency_at_ms) ||
          time(row.recency_at) ||
          time(row.updated_at_ms) ||
          time(row.updated_at),
        archivedAt: row.archived ? time(row.archived_at) || 1 : 0,
        display: display ?? "",
      };
      result.set(plainRolloutPath(summary.path), summary);
    }
  } catch {
    // No CLI, old schemas, locks, and corrupt optional indexes must not block browsing.
  }
  return result;
}
