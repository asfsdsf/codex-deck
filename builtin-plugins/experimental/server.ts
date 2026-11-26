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
  app.get("/api/codex/experimental", (c) =>
    run(c, async (client) => {
      if (!client.listExperimentalFeatures)
        return c.json({ error: "Experimental features unavailable." }, 501);
      return {
        features: await client.listExperimentalFeatures(
          c.req.query("threadId") || null,
        ),
      };
    }),
  );
  app.post("/api/codex/experimental", (c) =>
    run(c, async (client) => {
      const body = await c.req.json();
      if (
        !body.updates ||
        typeof body.updates !== "object" ||
        Array.isArray(body.updates) ||
        Object.values(body.updates).some(
          (value) => typeof value !== "boolean",
        ) ||
        Object.keys(body.updates).length > 100 ||
        (body.threadId != null && typeof body.threadId !== "string")
      )
        return c.json(
          {
            error:
              "Expected feature names mapped to boolean values and an optional thread ID.",
          },
          400,
        );
      if (!client.writeExperimentalFeatures)
        return c.json({ error: "Experimental settings unavailable." }, 501);
      return client.writeExperimentalFeatures(
        body.threadId || null,
        body.updates,
      );
    }),
  );
}
