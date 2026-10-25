import type { Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import { responseStatusForError, toErrorMessage } from "./utils";

export function registerNativeWorkflowRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    getClient?: () => Pick<
      CodexAppServerClientFacade,
      | "listMcpServers"
      | "loginMcpServer"
      | "reloadMcpServers"
      | "readUsageDashboard"
      | "consumeResetCredit"
    >;
  } = {},
) {
  const run = async (
    c: import("hono").Context,
    work: (
      client: ReturnType<NonNullable<typeof deps.getClient>>,
    ) => Promise<unknown>,
  ) => {
    try {
      deps.subscribe?.();
      const result = await work((deps.getClient ?? getCodexAppServerClient)());
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  };
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
  app.get("/api/codex/mcp", (c) =>
    run(c, async (client) => {
      if (!client.listMcpServers)
        throw new Error("MCP administration is unavailable on this server.");
      return client.listMcpServers(c.req.query("threadId") || undefined);
    }),
  );
  app.post("/api/codex/mcp/reload", (c) =>
    run(c, async (client) => {
      if (!client.reloadMcpServers)
        throw new Error("MCP reload is unavailable on this server.");
      await client.reloadMcpServers();
      return { ok: true };
    }),
  );
  app.post("/api/codex/mcp/login", (c) =>
    run(c, async (client) => {
      const body = await c.req.json();
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        (body.threadId != null && typeof body.threadId !== "string")
      )
        return c.json(
          { error: "MCP server name and optional thread ID are required." },
          400,
        );
      if (!client.loginMcpServer)
        throw new Error("MCP OAuth is unavailable on this server.");
      return client.loginMcpServer(body.name, body.threadId);
    }),
  );
}
