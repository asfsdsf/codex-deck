import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveRequestedWorkingDirectory } from "./path-utils";
import type { CodexThreadSummary } from "./storage/runtime";

export { resolveRequestedWorkingDirectory };

/** A request the user can correct (bad path, busy session); routes map it to 4xx. */
export class CodexWorkspaceError extends Error {
  public constructor(
    message: string,
    public readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "CodexWorkspaceError";
  }
}

export async function assertWorkingDirectory(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    const reason =
      error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "No such file or directory"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new CodexWorkspaceError(`Cannot access directory ${path}: ${reason}`);
  }
  if (!metadata.isDirectory()) {
    throw new CodexWorkspaceError(`Not a directory: ${path}`);
  }
}

export interface WorkingDirectoryChangeResult {
  previousThreadId: string;
  cwd: string;
  thread: CodexThreadSummary;
}

export interface WorkingDirectoryDeps {
  getThreadSummary: (threadId: string) => Promise<CodexThreadSummary>;
  forkThread: (
    threadId: string,
    options?: { cwd?: string },
  ) => Promise<CodexThreadSummary>;
  archiveThread?: (threadId: string) => Promise<void>;
}

export const WORKING_DIRECTORY_BUSY_MESSAGE =
  "Changing directories requires an idle primary session without queued input.";

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Upstream `/cd` replaces the conversation with a history-preserving fork that
 * starts in the new directory (Codex reloads project config, instructions, and
 * trust for the destination). The source conversation is left untouched.
 */
export async function changeThreadWorkingDirectory(
  deps: WorkingDirectoryDeps,
  threadId: string,
  requested: string,
  fallbackCwd?: string | null,
): Promise<WorkingDirectoryChangeResult> {
  const summary = await deps.getThreadSummary(threadId);
  if (summary.status === "active") {
    throw new CodexWorkspaceError("Cannot change: a task is running.", 409);
  }
  const baseCwd = summary.cwd || fallbackCwd?.trim() || "";
  let cwd: string;
  try {
    cwd = resolveRequestedWorkingDirectory(requested, baseCwd);
  } catch (error) {
    throw new CodexWorkspaceError(
      error instanceof Error ? error.message : String(error),
    );
  }
  await assertWorkingDirectory(cwd);
  let thread: CodexThreadSummary;
  try {
    thread = await deps.forkThread(threadId, { cwd });
  } catch (error) {
    throw new Error(
      `Failed to change: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (thread.threadId === threadId || !samePath(thread.cwd || "", cwd)) {
    if (thread.threadId !== threadId) {
      await deps.archiveThread?.(thread.threadId).catch(() => undefined);
    }
    throw new Error("Requested directory or permissions not applied.");
  }
  return { previousThreadId: threadId, cwd, thread };
}
