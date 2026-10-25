import type { Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
export function registerHookRunRoutes(
  app: Hono,
  getClient: () => Pick<
    CodexAppServerClientFacade,
    "listHookRuns"
  > = getCodexAppServerClient,
) {
  app.get("/api/codex/threads/:id/hook-runs", (c) => {
    const client = getClient();
    return c.json({ runs: client.listHookRuns?.(c.req.param("id")) ?? [] });
  });
}
