import { fork, type ChildProcess } from "node:child_process";
import type { ResolvedCodexHome } from "./codex-home-registry";
import {
  CODEX_HOME_RUNTIME_CHILD_ENV,
  CODEX_HOME_RUNTIME_TRANSLATION_ENV,
  isCodexHomeRuntimeChildMessage,
  type CodexHomeRuntimeAbortMessage,
  type CodexHomeRuntimeParentMessage,
  type CodexHomeRuntimeResponseChunkMessage,
  type CodexHomeRuntimeResponseEndMessage,
  type CodexHomeRuntimeResponseErrorMessage,
  type CodexHomeRuntimeResponseStartMessage,
} from "./codex-home-runtime-ipc";

export {
  CODEX_HOME_RUNTIME_CHILD_ENV,
  CODEX_HOME_RUNTIME_TRANSLATION_ENV,
} from "./codex-home-runtime-ipc";

interface PendingRuntimeRequest {
  resolve: (response: Response) => void;
  responseStarted: boolean;
  streamController: ReadableStreamDefaultController<Uint8Array> | null;
  removeAbortListener: () => void;
}

interface RuntimeHandle {
  child: ChildProcess;
  pendingRequests: Map<string, PendingRuntimeRequest>;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeErrorResponse(error: unknown): Response {
  return Response.json(
    { error: `Codex home runtime failed: ${toErrorMessage(error)}` },
    { status: 502 },
  );
}

function abortedResponse(): Response {
  return new Response(null, {
    status: 499,
    statusText: "Client Closed Request",
  });
}

function sendRuntimeMessage(
  child: ChildProcess,
  message: CodexHomeRuntimeParentMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("Codex home runtime IPC channel is closed"));
      return;
    }
    try {
      child.send(message, (error) => {
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

export class CodexHomeRuntimeManager {
  private readonly homesById: Map<string, ResolvedCodexHome>;
  private readonly runtimes = new Map<string, Promise<RuntimeHandle>>();
  private nextRequestId = 0;

  public constructor(
    homes: ResolvedCodexHome[],
    private readonly entryPath: string,
  ) {
    this.homesById = new Map(homes.map((home) => [home.id, home]));
  }

  public getHome(homeId: string): ResolvedCodexHome | null {
    return this.homesById.get(homeId) ?? null;
  }

  public async updateHomes(homes: ResolvedCodexHome[]): Promise<void> {
    const nextHomesById = new Map(homes.map((home) => [home.id, home]));
    const changedHomeIds = new Set<string>();

    for (const [homeId, current] of this.homesById) {
      const next = nextHomesById.get(homeId);
      if (
        !next ||
        current.path !== next.path ||
        current.available !== next.available ||
        current.translationCommand !== next.translationCommand
      ) {
        changedHomeIds.add(homeId);
      }
    }

    await Promise.all(
      Array.from(changedHomeIds, (homeId) => this.stopRuntime(homeId)),
    );
    this.homesById.clear();
    for (const [homeId, home] of nextHomesById) {
      this.homesById.set(homeId, home);
    }
  }

  public async fetch(homeId: string, request: Request): Promise<Response> {
    const home = this.getHome(homeId);
    if (!home) {
      return Response.json({ error: "Unknown Codex home" }, { status: 404 });
    }
    if (!home.available) {
      return Response.json(
        { error: home.unavailableReason || "Codex home is unavailable" },
        { status: 409 },
      );
    }
    if (request.signal.aborted) {
      return abortedResponse();
    }

    let runtime: RuntimeHandle;
    try {
      runtime = await this.getOrStartRuntime(home);
    } catch (error) {
      return runtimeErrorResponse(error);
    }

    const sourceUrl = new URL(request.url);
    sourceUrl.searchParams.delete("codexHome");
    const headers = new Headers(request.headers);
    headers.delete("connection");
    headers.delete("content-length");
    headers.delete("host");
    const method = request.method.toUpperCase();
    let bodyBase64: string | null = null;
    try {
      if (method !== "GET" && method !== "HEAD") {
        const body = await request.arrayBuffer();
        if (body.byteLength > 0) {
          bodyBase64 = Buffer.from(body).toString("base64");
        }
      }
    } catch (error) {
      return request.signal.aborted
        ? abortedResponse()
        : runtimeErrorResponse(error);
    }

    const requestId = `${home.id}:${++this.nextRequestId}`;
    let settleResponse: (response: Response) => void = () => {};
    const responsePromise = new Promise<Response>((resolve) => {
      settleResponse = resolve;
    });
    const onAbort = () => {
      this.abortRequest(runtime, requestId);
    };
    runtime.pendingRequests.set(requestId, {
      resolve: settleResponse,
      responseStarted: false,
      streamController: null,
      removeAbortListener: () => {
        request.signal.removeEventListener("abort", onAbort);
      },
    });
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) {
      onAbort();
      return responsePromise;
    }

    try {
      await sendRuntimeMessage(runtime.child, {
        type: "codex-home-runtime-request",
        requestId,
        url: sourceUrl.toString(),
        method,
        headers: Array.from(headers.entries()),
        bodyBase64,
      });
    } catch (error) {
      this.finishRequest(runtime, requestId, runtimeErrorResponse(error));
    }

    return responsePromise;
  }

  public stop(): void {
    for (const runtimePromise of this.runtimes.values()) {
      void runtimePromise
        .then((runtime) => {
          this.failPendingRequests(
            runtime,
            new Error("Codex home runtime stopped"),
          );
          if (!runtime.child.killed) {
            runtime.child.kill("SIGTERM");
          }
        })
        .catch(() => {});
    }
    this.runtimes.clear();
  }

  private getOrStartRuntime(home: ResolvedCodexHome): Promise<RuntimeHandle> {
    const existing = this.runtimes.get(home.id);
    if (existing) {
      return existing;
    }
    const runtime = this.startRuntime(home);
    this.runtimes.set(home.id, runtime);
    runtime.catch(() => {
      if (this.runtimes.get(home.id) === runtime) {
        this.runtimes.delete(home.id);
      }
    });
    return runtime;
  }

  private abortRequest(runtime: RuntimeHandle, requestId: string): void {
    const pending = runtime.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    const message: CodexHomeRuntimeAbortMessage = {
      type: "codex-home-runtime-abort",
      requestId,
    };
    void sendRuntimeMessage(runtime.child, message).catch(() => {});
    runtime.pendingRequests.delete(requestId);
    pending.removeAbortListener();
    if (pending.responseStarted) {
      try {
        pending.streamController?.close();
      } catch {}
      return;
    }
    pending.resolve(abortedResponse());
  }

  private finishRequest(
    runtime: RuntimeHandle,
    requestId: string,
    fallbackResponse?: Response,
  ): void {
    const pending = runtime.pendingRequests.get(requestId);
    if (!pending) {
      return;
    }
    runtime.pendingRequests.delete(requestId);
    pending.removeAbortListener();
    if (!pending.responseStarted) {
      pending.resolve(
        fallbackResponse ??
          runtimeErrorResponse("Runtime ended before sending a response"),
      );
      return;
    }
    try {
      pending.streamController?.close();
    } catch {}
  }

  private handleResponseStart(
    runtime: RuntimeHandle,
    message: CodexHomeRuntimeResponseStartMessage,
  ): void {
    const pending = runtime.pendingRequests.get(message.requestId);
    if (!pending || pending.responseStarted) {
      return;
    }
    pending.responseStarted = true;
    const body = message.hasBody
      ? new ReadableStream<Uint8Array>({
          start: (controller) => {
            pending.streamController = controller;
          },
          pull: () =>
            sendRuntimeMessage(runtime.child, {
              type: "codex-home-runtime-response-credit",
              requestId: message.requestId,
            }).catch(() => {
              this.abortRequest(runtime, message.requestId);
            }),
          cancel: () => {
            this.abortRequest(runtime, message.requestId);
          },
        })
      : null;
    pending.resolve(
      new Response(body, {
        status: message.status,
        statusText: message.statusText,
        headers: message.headers,
      }),
    );
  }

  private handleResponseChunk(
    runtime: RuntimeHandle,
    message: CodexHomeRuntimeResponseChunkMessage,
  ): void {
    const pending = runtime.pendingRequests.get(message.requestId);
    if (!pending?.responseStarted || !pending.streamController) {
      return;
    }
    try {
      pending.streamController.enqueue(
        Buffer.from(message.chunkBase64, "base64"),
      );
    } catch {
      this.abortRequest(runtime, message.requestId);
    }
  }

  private handleResponseEnd(
    runtime: RuntimeHandle,
    message: CodexHomeRuntimeResponseEndMessage,
  ): void {
    this.finishRequest(runtime, message.requestId);
  }

  private handleResponseError(
    runtime: RuntimeHandle,
    message: CodexHomeRuntimeResponseErrorMessage,
  ): void {
    const pending = runtime.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    if (!pending.responseStarted) {
      this.finishRequest(
        runtime,
        message.requestId,
        runtimeErrorResponse(message.error),
      );
      return;
    }
    runtime.pendingRequests.delete(message.requestId);
    pending.removeAbortListener();
    pending.streamController?.error(new Error(message.error));
  }

  private failPendingRequests(runtime: RuntimeHandle, error: Error): void {
    for (const [requestId, pending] of runtime.pendingRequests) {
      if (!pending.responseStarted) {
        pending.resolve(runtimeErrorResponse(error));
      } else {
        pending.streamController?.error(error);
      }
      pending.removeAbortListener();
      runtime.pendingRequests.delete(requestId);
    }
  }

  private async stopRuntime(
    homeId: string,
    expectedChild?: ChildProcess,
    terminate = true,
  ): Promise<void> {
    const runtimePromise = this.runtimes.get(homeId);
    if (!runtimePromise) {
      return;
    }
    try {
      const runtime = await runtimePromise;
      if (
        this.runtimes.get(homeId) !== runtimePromise ||
        (expectedChild && runtime.child !== expectedChild)
      ) {
        return;
      }
      this.runtimes.delete(homeId);
      this.failPendingRequests(
        runtime,
        new Error(`Codex home runtime ${homeId} exited`),
      );
      if (terminate && !runtime.child.killed) {
        runtime.child.kill("SIGTERM");
      }
    } catch {
      if (this.runtimes.get(homeId) === runtimePromise) {
        this.runtimes.delete(homeId);
      }
    }
  }

  private startRuntime(home: ResolvedCodexHome): Promise<RuntimeHandle> {
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CODEX_HOME: home.path,
        [CODEX_HOME_RUNTIME_CHILD_ENV]: "1",
      };
      if (home.translationCommand) {
        env[CODEX_HOME_RUNTIME_TRANSLATION_ENV] = home.translationCommand;
      } else {
        delete env[CODEX_HOME_RUNTIME_TRANSLATION_ENV];
      }

      const child = fork(this.entryPath, ["--dir", home.path, "--no-open"], {
        env,
        execArgv: process.execArgv,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      const runtime: RuntimeHandle = {
        child,
        pendingRequests: new Map(),
      };
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error(`Timed out starting Codex home runtime ${home.id}`));
      }, 20_000);

      const cleanupStartup = () => {
        clearTimeout(timeout);
        child.off("error", fail);
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupStartup();
        child.removeListener("message", handleMessage);
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        reject(error);
      };
      const handleMessage = (value: unknown) => {
        if (!isCodexHomeRuntimeChildMessage(value)) {
          return;
        }
        if (value.type === "codex-home-runtime-ready") {
          if (settled) {
            return;
          }
          settled = true;
          cleanupStartup();
          resolve(runtime);
          return;
        }
        if (value.type === "codex-home-runtime-startup-error") {
          fail(new Error(value.error));
          return;
        }
        if (!settled) {
          return;
        }
        if (value.type === "codex-home-runtime-response-start") {
          this.handleResponseStart(runtime, value);
        } else if (value.type === "codex-home-runtime-response-chunk") {
          this.handleResponseChunk(runtime, value);
        } else if (value.type === "codex-home-runtime-response-end") {
          this.handleResponseEnd(runtime, value);
        } else if (value.type === "codex-home-runtime-response-error") {
          this.handleResponseError(runtime, value);
        }
      };

      child.on("message", handleMessage);
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (!settled) {
          fail(
            new Error(
              `Codex home runtime ${home.id} exited before startup (${code ?? signal ?? "unknown"})`,
            ),
          );
          return;
        }
        this.failPendingRequests(
          runtime,
          new Error(
            `Codex home runtime ${home.id} exited (${code ?? signal ?? "unknown"})`,
          ),
        );
        void this.stopRuntime(home.id, child, false);
      });
    });
  }
}
