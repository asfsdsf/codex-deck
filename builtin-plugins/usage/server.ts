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
  app.get("/api/codex/usage", (c) =>
    run(c, async (client) => {
      if (!client.readUsageDashboard)
        return c.json({ error: "Usage dashboard unavailable." }, 501);
      return client.readUsageDashboard(c.req.query("threadId") || null);
    }),
  );
  app.post("/api/codex/usage/reset-credit", (c) =>
    run(c, async (client) => {
      const body = await c.req.json();
      if (
        typeof body.idempotencyKey !== "string" ||
        !body.idempotencyKey.trim() ||
        body.idempotencyKey.length > 200 ||
        (body.creditId != null && typeof body.creditId !== "string")
      )
        return c.json(
          { error: "A reset attempt ID and optional credit ID are required." },
          400,
        );
      if (!client.consumeResetCredit)
        return c.json({ error: "Reset credits unavailable." }, 501);
      return client.consumeResetCredit(body.idempotencyKey, body.creditId);
    }),
  );
}
