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
      "listMcpServers" | "loginMcpServer" | "reloadMcpServers"
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
