import type { Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import { responseStatusForError, toErrorMessage } from "./utils";

export function registerMemoryInsightRoutes(
  app: Hono,
  getClient: () => Pick<
    CodexAppServerClientFacade,
    "readThreadMemory" | "readMemoryStatus"
  > = getCodexAppServerClient,
) {
  app.get("/api/codex/memories/status", async (c) => {
    try {
      const client = getClient();
      if (!client.readMemoryStatus)
        return c.json({ error: "Memory readiness is unavailable." }, 501);
      return c.json(await client.readMemoryStatus());
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });
  app.get("/api/codex/threads/:id/memory", async (c) => {
    try {
      const client = getClient();
      if (!client.readThreadMemory)
        return c.json(
          { error: "Thread memory summaries are unavailable." },
          501,
        );
      return c.json(await client.readThreadMemory(c.req.param("id")));
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });
}
