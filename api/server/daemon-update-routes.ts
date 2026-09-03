import type { Hono } from "hono";
import type { CodexDeckUpdateMethod, CodexDeckUpdateRequest } from "../storage";
import type { DaemonUpdater } from "../daemon-updater";
import { toErrorMessage } from "./utils";

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
