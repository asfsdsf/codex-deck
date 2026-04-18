import {
  CodexAppServerRpcError,
  CodexAppServerTransportError,
} from "../codex-app-server";

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
