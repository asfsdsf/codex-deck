import type { Hono } from "hono";
import {
  builtinCodexRouteRunner,
  type BuiltinCodexRouteOptions,
} from "../server-context";

export function registerFeatureRoutes(
  app: Hono,
  deps: BuiltinCodexRouteOptions = {},
) {
  const run = builtinCodexRouteRunner(deps);
  app.get("/api/codex/threads/:id/daybreak", (c) =>
    run(c, async (client) => {
      if (!client.getDaybreak)
        return c.json({ error: "Daybreak selection unavailable." }, 501);
      return client.getDaybreak(c.req.param("id"), c.req.query("model"));
    }),
  );
  app.post("/api/codex/threads/:id/daybreak", (c) =>
    run(c, async (client) => {
      const body = await c.req.json();
      if (
        typeof body.enabled !== "boolean" ||
        (body.model != null && typeof body.model !== "string")
      )
        return c.json(
          { error: "Expected an enabled boolean and optional model." },
          400,
        );
      if (!client.setDaybreak)
        return c.json({ error: "Daybreak selection unavailable." }, 501);
      return client.setDaybreak(c.req.param("id"), body.enabled, body.model);
    }),
  );
}
