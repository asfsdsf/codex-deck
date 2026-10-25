import type { Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
export function registerOperationalNotificationRoutes(
  app: Hono,
  getClient: () => Pick<
    CodexAppServerClientFacade,
    "listOperationalNotifications"
  > = getCodexAppServerClient,
) {
  app.get("/api/codex/notifications", (c) =>
    c.json({
      notifications:
        getClient().listOperationalNotifications?.(c.req.query("threadId")) ??
        [],
    }),
  );
}
