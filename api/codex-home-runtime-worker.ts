import type { ReadableStreamDefaultReader } from "node:stream/web";
import {
  isCodexHomeRuntimeParentMessage,
  type CodexHomeRuntimeChildMessage,
  type CodexHomeRuntimeRequestMessage,
} from "./codex-home-runtime-ipc";

const IPC_CHUNK_SIZE = 256 * 1024;

interface RuntimeApp {
  fetch(request: Request): Response | Promise<Response>;
}

interface ActiveRuntimeRequest {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  responseCredits: number;
  creditWaiters: Array<(available: boolean) => void>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendRuntimeMessage(
  message: CodexHomeRuntimeChildMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("Codex home runtime IPC channel is closed"));
      return;
    }
    try {
      process.send(message, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function sendResponseChunk(
  requestId: string,
  value: Uint8Array,
  activeRequest: ActiveRuntimeRequest,
): Promise<boolean> {
  for (let offset = 0; offset < value.byteLength; offset += IPC_CHUNK_SIZE) {
    if (!(await takeResponseCredit(activeRequest))) {
      return false;
    }
    const chunk = value.subarray(
      offset,
      Math.min(value.byteLength, offset + IPC_CHUNK_SIZE),
    );
    await sendRuntimeMessage({
      type: "codex-home-runtime-response-chunk",
      requestId,
      chunkBase64: Buffer.from(chunk).toString("base64"),
    });
  }
  return true;
}

function takeResponseCredit(
  activeRequest: ActiveRuntimeRequest,
): Promise<boolean> {
  if (activeRequest.controller.signal.aborted) {
    return Promise.resolve(false);
  }
  if (activeRequest.responseCredits > 0) {
    activeRequest.responseCredits -= 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    activeRequest.creditWaiters.push(resolve);
  });
}

function grantResponseCredit(activeRequest: ActiveRuntimeRequest): void {
  const waiter = activeRequest.creditWaiters.shift();
  if (waiter) {
    waiter(true);
    return;
  }
  activeRequest.responseCredits += 1;
}

function abortActiveRequest(activeRequest: ActiveRuntimeRequest): void {
  activeRequest.controller.abort();
  for (const resolve of activeRequest.creditWaiters.splice(0)) {
    resolve(false);
  }
  void activeRequest.reader?.cancel().catch(() => {});
}

function responseCanHaveBody(method: string, response: Response): boolean {
  return (
    method !== "HEAD" &&
    response.body !== null &&
    response.status !== 204 &&
    response.status !== 205 &&
    response.status !== 304
  );
}

export async function startCodexHomeRuntimeWorker(
  app: RuntimeApp,
): Promise<void> {
  const activeRequests = new Map<string, ActiveRuntimeRequest>();

  const handleRequest = async (
    message: CodexHomeRuntimeRequestMessage,
  ): Promise<void> => {
    const controller = new AbortController();
    const activeRequest: ActiveRuntimeRequest = {
      controller,
      reader: null,
      responseCredits: 0,
      creditWaiters: [],
    };
    activeRequests.set(message.requestId, activeRequest);
    let responseStarted = false;

    try {
      const body = message.bodyBase64
        ? Buffer.from(message.bodyBase64, "base64")
        : undefined;
      const request = new Request(message.url, {
        method: message.method,
        headers: message.headers,
        body,
        signal: controller.signal,
      });
      const response = await app.fetch(request);
      const hasBody = responseCanHaveBody(message.method, response);
      await sendRuntimeMessage({
        type: "codex-home-runtime-response-start",
        requestId: message.requestId,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
        hasBody,
      });
      responseStarted = true;

      if (hasBody && response.body) {
        const reader = response.body.getReader();
        activeRequest.reader = reader;
        while (!controller.signal.aborted) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          if (
            !(await sendResponseChunk(
              message.requestId,
              result.value,
              activeRequest,
            ))
          ) {
            break;
          }
        }
      }

      await sendRuntimeMessage({
        type: "codex-home-runtime-response-end",
        requestId: message.requestId,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (responseStarted) {
          await sendRuntimeMessage({
            type: "codex-home-runtime-response-end",
            requestId: message.requestId,
          }).catch(() => {});
        }
      } else {
        await sendRuntimeMessage({
          type: "codex-home-runtime-response-error",
          requestId: message.requestId,
          error: toErrorMessage(error),
        }).catch(() => {});
      }
    } finally {
      activeRequests.delete(message.requestId);
    }
  };

  process.on("message", (value: unknown) => {
    if (!isCodexHomeRuntimeParentMessage(value)) {
      return;
    }
    if (value.type === "codex-home-runtime-abort") {
      const activeRequest = activeRequests.get(value.requestId);
      if (activeRequest) {
        abortActiveRequest(activeRequest);
      }
      return;
    }
    if (value.type === "codex-home-runtime-response-credit") {
      const activeRequest = activeRequests.get(value.requestId);
      if (activeRequest) {
        grantResponseCredit(activeRequest);
      }
      return;
    }
    void handleRequest(value);
  });

  process.once("disconnect", () => {
    for (const activeRequest of activeRequests.values()) {
      abortActiveRequest(activeRequest);
    }
    activeRequests.clear();
  });

  await sendRuntimeMessage({ type: "codex-home-runtime-ready" });
}
