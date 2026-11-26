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
  app.get("/api/codex/warnings", (c) =>
    run(c, async (client) => {
      if (!client.listRetainedWarnings)
        return c.json({ error: "Retained warnings unavailable." }, 501);
      return {
        warnings: client.listRetainedWarnings(c.req.query("threadId") || null),
      };
    }),
  );
  app.get("/api/codex/debug-config", (c) =>
    run(c, async (client) => {
      if (!client.getConfigDiagnostics)
        return c.json({ error: "Configuration diagnostics unavailable." }, 501);
      return client.getConfigDiagnostics(c.req.query("threadId") || null);
    }),
  );
}
