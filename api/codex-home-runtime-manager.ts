import { fork, type ChildProcess } from "node:child_process";
import type { ResolvedCodexHome } from "./codex-home-registry";

export const CODEX_HOME_RUNTIME_CHILD_ENV = "CODEXDECK_RUNTIME_CHILD";
export const CODEX_HOME_RUNTIME_TRANSLATION_ENV =
  "CODEXDECK_RUNTIME_TRANSLATION_COMMAND";

interface RuntimeReadyMessage {
  type: "codex-home-runtime-ready";
  port: number;
}

interface RuntimeErrorMessage {
  type: "codex-home-runtime-error";
  error: string;
}

type RuntimeMessage = RuntimeReadyMessage | RuntimeErrorMessage;

interface RuntimeHandle {
  child: ChildProcess;
  port: number;
}

function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === "codex-home-runtime-ready" || type === "codex-home-runtime-error"
  );
}

export class CodexHomeRuntimeManager {
  private readonly homesById: Map<string, ResolvedCodexHome>;
  private readonly runtimes = new Map<string, Promise<RuntimeHandle>>();

  public constructor(
    homes: ResolvedCodexHome[],
    private readonly entryPath: string,
  ) {
    this.homesById = new Map(homes.map((home) => [home.id, home]));
  }

  public getHome(homeId: string): ResolvedCodexHome | null {
    return this.homesById.get(homeId) ?? null;
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

    const sourceUrl = new URL(request.url);
    sourceUrl.searchParams.delete("codexHome");
    const headers = new Headers(request.headers);
    headers.delete("connection");
    headers.delete("content-length");
    headers.delete("host");
    const method = request.method.toUpperCase();
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await request.arrayBuffer();

    let runtime: RuntimeHandle | null = null;
    try {
      runtime = await this.getOrStartRuntime(home);
      const runtimeUrl = new URL(
        `${sourceUrl.pathname}${sourceUrl.search}`,
        `http://127.0.0.1:${runtime.port}`,
      );
      return await fetch(runtimeUrl, {
        method,
        headers,
        body: body && body.byteLength > 0 ? body : undefined,
        signal: request.signal,
        redirect: "manual",
      });
    } catch (error) {
      void this.stopRuntime(home.id, runtime?.child);
      return Response.json(
        {
          error: `Codex home runtime failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 502 },
      );
    }
  }

  public stop(): void {
    for (const runtimePromise of this.runtimes.values()) {
      void runtimePromise
        .then(({ child }) => {
          if (!child.killed) {
            child.kill("SIGTERM");
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
      const { child } = await runtimePromise;
      if (
        this.runtimes.get(homeId) !== runtimePromise ||
        (expectedChild && child !== expectedChild)
      ) {
        return;
      }
      this.runtimes.delete(homeId);
      if (terminate && !child.killed) {
        child.kill("SIGTERM");
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

      const child = fork(
        this.entryPath,
        ["--port", "0", "--dir", home.path, "--no-open"],
        {
          env,
          execArgv: process.execArgv,
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error(`Timed out starting Codex home runtime ${home.id}`));
      }, 20_000);

      const cleanup = () => {
        clearTimeout(timeout);
        child.off("message", handleMessage);
        child.off("error", fail);
        child.off("exit", handleEarlyExit);
      };
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (!child.killed) {
          child.kill("SIGTERM");
        }
        reject(error);
      };
      const handleEarlyExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        fail(
          new Error(
            `Codex home runtime ${home.id} exited before startup (${code ?? signal ?? "unknown"})`,
          ),
        );
      };
      const handleMessage = (message: unknown) => {
        if (!isRuntimeMessage(message)) {
          return;
        }
        if (message.type === "codex-home-runtime-error") {
          fail(new Error(message.error));
          return;
        }
        if (!Number.isInteger(message.port) || message.port <= 0) {
          fail(
            new Error(`Codex home runtime ${home.id} returned an invalid port`),
          );
          return;
        }
        settled = true;
        cleanup();
        child.once("exit", () => {
          void this.stopRuntime(home.id, child, false);
        });
        resolve({ child, port: message.port });
      };

      child.on("message", handleMessage);
      child.once("error", fail);
      child.once("exit", handleEarlyExit);
    });
  }
}
