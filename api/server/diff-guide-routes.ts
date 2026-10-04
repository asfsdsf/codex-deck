import type { Hono } from "hono";
import {
  getCodexAppServerClient,
  isCodexReasoningEffort,
} from "../codex-app-server";
import {
  getCodexDir,
  type DiffGuideStartRequest,
  type DiffGuideContentResponse,
} from "../storage";
import { DiffGuideStore } from "../diff-guide-store";
import { DiffGuideService } from "../diff-guide";
import { resolveSessionProjectPath } from "./route-helpers";
import { responseStatusForError, toErrorMessage } from "./utils";

export function registerDiffGuideRoutes(app: Hono) {
  const service = new DiffGuideService(
    new DiffGuideStore(getCodexDir()),
    getCodexAppServerClient,
    resolveSessionProjectPath,
  );
  app.post("/api/diff-guides/start", async (c) => {
    try {
      const input = await c.req.json<DiffGuideStartRequest>();
      if (
        !input ||
        typeof input.sourceSessionId !== "string" ||
        typeof input.requestId !== "string" ||
        (input.prompt !== undefined && typeof input.prompt !== "string") ||
        (input.model != null && typeof input.model !== "string") ||
        (input.effort != null && !isCodexReasoningEffort(input.effort)) ||
        (input.retry !== undefined && typeof input.retry !== "boolean") ||
        (input.skillInstallChoice != null &&
          !["local", "global"].includes(input.skillInstallChoice))
      ) {
        return c.json({ error: "Invalid diff guide start request" }, 400);
      }
      return c.json(await service.start(input));
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        error instanceof SyntaxError ||
          /Invalid|Request ID/.test(toErrorMessage(error))
          ? 400
          : responseStatusForError(error),
      );
    }
  });
  app.get("/api/diff-guides", async (c) => {
    try {
      return c.json(await service.summaries());
    } catch (error) {
      return c.json({ error: toErrorMessage(error) }, 500);
    }
  });
  app.get("/api/diff-guides/:id", async (c) => {
    try {
      const record = await service.store.read(c.req.param("id"));
      if (!record) return c.json({ error: "Diff guide not found" }, 404);
      const guide = await service.summary(record);
      const html =
        guide.status === "ready" ? await service.store.content(record) : null;
      return c.json({ guide, html } satisfies DiffGuideContentResponse);
    } catch (error) {
      return c.json({ error: toErrorMessage(error) }, 400);
    }
  });
  app.post("/api/diff-guides/:id/retry", async (c) => {
    try {
      const record = await service.store.read(c.req.param("id"));
      if (!record) return c.json({ error: "Diff guide not found" }, 404);
      return c.json(
        await service.start({
          sourceSessionId: record.parentSessionId,
          requestId: record.requestId,
          prompt: record.prompt,
          retry: true,
        }),
      );
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });
  return service;
}
