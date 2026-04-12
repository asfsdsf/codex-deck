import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export async function createTempCodexDir(prefix: string): Promise<{
  rootDir: string;
  sessionsDir: string;
  cleanup: () => Promise<void>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const sessionsDir = join(rootDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });

  return {
    rootDir,
    sessionsDir,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

export async function writeSessionFile(
  sessionsDir: string,
  relativePath: string,
  lines: string[],
): Promise<string> {
  const filePath = join(sessionsDir, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

export async function writeHistoryFile(
  rootDir: string,
  lines: string[],
): Promise<string> {
  const filePath = join(rootDir, "history.jsonl");
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf-8");
  return filePath;
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function sessionMetaLine(
  id: string,
  cwd: string,
  timestamp: number,
): string {
  return JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      cwd,
      timestamp,
    },
  });
}

export function responseItemMessageLine(
  role: "user" | "assistant",
  text: string,
  timestamp: string = "2026-01-01T00:00:00.000Z",
): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: "output_text", text }],
    },
  });
}

export function responseItemRawLine(payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "response_item",
    payload,
  });
}

export function eventMsgLine(payload: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "event_msg",
    payload,
  });
}
