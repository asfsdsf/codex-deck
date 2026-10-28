import type { Context, Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import {
  parseForkBoundary,
  ThreadHistoryRequestError,
} from "../codex-thread-history";
import type { CodexThreadForkResponse } from "../storage";
import { responseStatusForError, toErrorMessage } from "./utils";

type ThreadHistoryClient = Pick<CodexAppServerClientFacade, "forkThread">;

/** Turn-boundary forks of a stored conversation. */
export function registerThreadHistoryRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    getClient?: () => ThreadHistoryClient;
  } = {},
) {
  const run = async (
    c: Context,
    work: (client: ThreadHistoryClient, threadId: string) => Promise<unknown>,
  ) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) return c.json({ error: "thread id is required" }, 400);
    try {
      deps.subscribe?.();
      const result = await work(
        (deps.getClient ?? getCodexAppServerClient)(),
        threadId,
      );
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      if (error instanceof ThreadHistoryRequestError)
        return c.json({ error: error.message }, error.status);
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  };
  const body = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw new ThreadHistoryRequestError("Request body must be JSON.");
    }
  };

  app.post("/api/codex/threads/:id/fork-at", (c) =>
    run(c, async (client, threadId) => {
      const boundary = parseForkBoundary(await body(c));
      if (!boundary)
        throw new ThreadHistoryRequestError(
          "lastTurnId or beforeTurnId is required.",
        );
      if (!client.forkThread)
        return c.json(
          { error: "Thread fork is not available for this codex client" },
          503,
        );
      const response: CodexThreadForkResponse = {
        thread: await client.forkThread(threadId, boundary),
      };
      return response;
    }),
  );
}
