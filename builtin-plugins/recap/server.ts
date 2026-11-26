import type { Hono } from "hono";
import {
  builtinCodexRouteRunner,
  type BuiltinCodexRouteOptions,
} from "../server-context";
import { getConversation } from "../../api/storage";
import { recapHistory } from "../../api/codex-recap";

export function registerFeatureRoutes(
  app: Hono,
  deps: BuiltinCodexRouteOptions = {},
) {
  const run = builtinCodexRouteRunner(deps);
  app.get("/api/codex/threads/:id/recap", (c) =>
    run(c, async (client) => ({
      recap: client.getRecap?.(c.req.param("id")) ?? null,
    })),
  );
  app.post("/api/codex/threads/:id/recap", (c) =>
    run(c, async (client) => {
      if (!client.startRecap)
        return c.json({ error: "Conversation recaps unavailable." }, 501);
      const id = c.req.param("id");
      return {
        recap: client.startRecap(id, recapHistory(await getConversation(id))),
      };
    }),
  );
}
