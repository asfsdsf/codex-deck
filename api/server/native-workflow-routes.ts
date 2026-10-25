import { getConversation } from "../storage";
import { recapHistory } from "../codex-recap";
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
      | "getDaybreak"
      | "setDaybreak"
      | "listExperimentalFeatures"
      | "writeExperimentalFeatures"
      | "getRecap"
      | "startRecap"
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
