import type { Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import { parseReviewTarget } from "../codex-review";
import { responseStatusForError, toErrorMessage } from "./utils";

export function registerReviewRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    wake?: (threadId: string) => void;
    getClient?: () => Pick<CodexAppServerClientFacade, "startReview">;
  } = {},
) {
  app.post("/api/codex/threads/:id/review", async (c) => {
    let target;
    try {
      target = parseReviewTarget((await c.req.json()).target);
    } catch (error) {
      return c.json({ error: toErrorMessage(error) }, 400);
    }
    try {
      const client = (deps.getClient ?? getCodexAppServerClient)();
      if (!client.startReview)
        return c.json({ error: "Native review is unavailable." }, 501);
      deps.subscribe?.();
      const result = await client.startReview(c.req.param("id"), target);
      deps.wake?.(result.threadId);
      return c.json(result);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });
}
