import {
  CodexAppServerRpcError,
  CodexAppServerTransportError,
} from "../codex-app-server";
import { homedir } from "os";
import { join } from "path";

export const MAX_LONG_POLL_WAIT_MS = 25_000;

export async function waitForAbortableTimeout(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve();
    };
    const handleAbort = () => {
      finish();
    };
    const timeout = setTimeout(finish, ms);
    timeout.unref?.();
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

export function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0) {
      return null;
    }
    return Math.floor(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  }

  return null;
}

export function responseStatusForError(error: unknown): 400 | 500 | 503 {
  if (error instanceof CodexAppServerTransportError) {
    return 503;
  }
  if (error instanceof CodexAppServerRpcError) {
    return 500;
  }
  if (error instanceof SyntaxError) {
    return 400;
  }
  return 500;
}

export function parseOptionalString(
  value: unknown,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function normalizeCwdPath(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }
  if (normalized === "~") {
    return homedir();
  }
  if (normalized.startsWith("~/")) {
    return join(homedir(), normalized.slice(2));
  }
  return normalized;
}
