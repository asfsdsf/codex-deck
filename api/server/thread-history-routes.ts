import type { Context, Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import {
  parseAttachmentInput,
  parseForkBoundary,
  parseRevertTurnId,
  ThreadHistoryRequestError,
} from "../codex-thread-history";
import {
  refreshSessionRollout,
  type CodexThreadForkResponse,
} from "../storage";
import { responseStatusForError, toErrorMessage } from "./utils";

type ThreadHistoryClient = Pick<
  CodexAppServerClientFacade,
  | "forkThread"
  | "revertThread"
  | "listThreadAttachments"
  | "addThreadAttachment"
  | "removeThreadAttachment"
>;

/** Turn-boundary forks, rewinds, and durable attachments of a conversation. */
export function registerThreadHistoryRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    /** Re-reads conversation streams so every client reconciles a rewind. */
    wake?: (threadId: string) => void;
    refreshRollout?: (threadId: string) => Promise<void>;
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

  app.post("/api/codex/threads/:id/revert", (c) =>
    run(c, async (client, threadId) => {
      const beforeTurnId = parseRevertTurnId(await body(c));
      if (!client.revertThread)
        return c.json(
          {
            error: "Conversation rewind is not available for this codex client",
          },
          503,
        );
      const result = await client.revertThread(threadId, beforeTurnId);
      // The revert committed a new rollout; reconcile even if refresh fails.
      await (deps.refreshRollout ?? refreshSessionRollout)(threadId).catch(
        () => {},
      );
      deps.wake?.(threadId);
      return result;
    }),
  );

  const unavailable = (c: Context) =>
    c.json(
      { error: "Thread attachments are not available for this codex client" },
      503,
    );
  app.get("/api/codex/threads/:id/attachments", (c) =>
    run(c, async (client, threadId) => {
      if (!client.listThreadAttachments) return unavailable(c);
      return { attachments: await client.listThreadAttachments(threadId) };
    }),
  );
  app.post("/api/codex/threads/:id/attachments", (c) =>
    run(c, async (client, threadId) => {
      const input = parseAttachmentInput(await body(c), true);
      if (!client.addThreadAttachment) return unavailable(c);
      return client.addThreadAttachment(threadId, input);
    }),
  );
  app.post("/api/codex/threads/:id/attachments/remove", (c) =>
    run(c, async (client, threadId) => {
      const { attachmentType, identityKey } = parseAttachmentInput(
        await body(c),
        false,
      );
      if (!client.removeThreadAttachment) return unavailable(c);
      await client.removeThreadAttachment(threadId, {
        attachmentType,
        identityKey,
      });
      return { ok: true };
    }),
  );
}
