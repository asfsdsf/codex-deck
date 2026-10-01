import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { CodexDeckUpdateMethod, CodexDeckUpdateRequest } from "../storage";
import type { DaemonUpdater } from "../daemon-updater";
import { toErrorMessage, waitForAbortableTimeout } from "./utils";

function isUpdateMethod(value: unknown): value is CodexDeckUpdateMethod {
  return value === "npm" || value === "source";
}

function updateErrorStatus(error: unknown): 400 | 409 | 500 | 503 {
  const message = toErrorMessage(error).toLowerCase();
  if (message.includes("already in progress")) {
    return 409;
  }
  if (
    message.includes("available only") ||
    message.includes("environment is incomplete")
  ) {
    return 503;
  }
  if (
    message.includes("sourceroot") ||
    message.includes("source project") ||
    message.includes("package.json") ||
    message.includes("line breaks")
  ) {
    return 400;
  }
  return 500;
}

export function registerDaemonUpdateRoutes(
  app: Hono,
  updater: DaemonUpdater,
): void {
  app.get("/api/codex-deck/update", async (c) => {
    return c.json(await updater.getStatus());
  });

  app.get("/api/codex-deck/update/output", (c) => {
    return c.json(updater.getOutput());
  });

  app.get("/api/codex-deck/update/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let writes = Promise.resolve();
      const sendOutput = () => {
        writes = writes
          .then(async () => {
            if (!controller.signal.aborted) {
              await stream.writeSSE({
                event: "updateOutput",
                data: JSON.stringify(updater.getOutput()),
              });
            }
          })
          .catch(cleanup);
      };
      const unsubscribe = updater.subscribeOutput(() => {
        if (timer || controller.signal.aborted) {
          return;
        }
        timer = setTimeout(() => {
          timer = null;
          sendOutput();
        }, 100);
      });
      const cleanup = () => {
        controller.abort();
        unsubscribe();
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        c.req.raw.signal.removeEventListener("abort", cleanup);
      };
      stream.onAbort(cleanup);
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });

      try {
        sendOutput();
        while (!controller.signal.aborted) {
          await waitForAbortableTimeout(15_000, controller.signal);
          if (!controller.signal.aborted) {
            await stream.writeSSE({ event: "heartbeat", data: "" });
          }
        }
      } finally {
        cleanup();
        await writes;
      }
    });
  });

  app.post("/api/codex-deck/update/check", async (c) => {
    try {
      return c.json(await updater.checkNpm());
    } catch (error) {
      return c.json({ error: toErrorMessage(error) }, 500);
    }
  });

  app.post("/api/codex-deck/update", async (c) => {
    let body: Partial<CodexDeckUpdateRequest> | null = null;
    try {
      body = (await c.req.json()) as Partial<CodexDeckUpdateRequest>;
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }
    if (!body || !isUpdateMethod(body.method)) {
      return c.json({ error: "method must be npm or source" }, 400);
    }
    if (body.sourceRoot !== undefined && typeof body.sourceRoot !== "string") {
      return c.json({ error: "sourceRoot must be a string" }, 400);
    }

    try {
      return c.json(
        await updater.update({
          method: body.method,
          sourceRoot: body.sourceRoot,
        }),
      );
    } catch (error) {
      return c.json({ error: toErrorMessage(error) }, updateErrorStatus(error));
    }
  });
}
