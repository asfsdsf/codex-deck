import type { Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import { responseStatusForError, toErrorMessage } from "./utils";
export function registerBackgroundTerminalRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    getClient?: () => Pick<
      CodexAppServerClientFacade,
      "listBackgroundTerminals" | "terminateBackgroundTerminal"
    >;
  } = {},
) {
  app.get("/api/codex/threads/:id/background-terminals", async (c) => {
    try {
      deps.subscribe?.();
      const client = (deps.getClient ?? getCodexAppServerClient)();
      if (!client.listBackgroundTerminals)
        return c.json(
          { error: "Background process listing is unavailable." },
          501,
        );
      return c.json({
        terminals: await client.listBackgroundTerminals(c.req.param("id")),
      });
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });
  app.post(
    "/api/codex/threads/:id/background-terminals/:processId/terminate",
    async (c) => {
      try {
        deps.subscribe?.();
        const client = (deps.getClient ?? getCodexAppServerClient)();
        if (!client.terminateBackgroundTerminal)
          return c.json(
            { error: "Individual process termination is unavailable." },
            501,
          );
        return c.json({
          terminated: await client.terminateBackgroundTerminal(
            c.req.param("id"),
            c.req.param("processId"),
          ),
        });
      } catch (error) {
        return c.json(
          { error: toErrorMessage(error) },
          responseStatusForError(error),
        );
      }
    },
  );
}
