import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import {
  THREAD_QUEUE_UNSUPPORTED_MESSAGE,
  isUnsupportedThreadQueueError,
  parseQueueInputItems,
} from "../codex-thread-queue";
import { responseStatusForError, toErrorMessage } from "./utils";

type QueueClient = Pick<
  CodexAppServerClientFacade,
  | "listThreadQueue"
  | "addThreadQueueMessage"
  | "updateThreadQueueMessage"
  | "deleteThreadQueueMessage"
  | "reorderThreadQueue"
  | "moveThreadQueueMessage"
  | "startThreadQueueMessage"
>;

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Shared message queue routes (`thread/queue/*`). The app-server drains the
 * queue itself when a turn completes, so no route starts items implicitly.
 */
export function registerThreadQueueRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    wake?: (threadId: string) => void;
    getClient?: () => QueueClient;
  } = {},
) {
  const run = async (
    c: Context,
    work: (client: QueueClient, threadId: string) => Promise<unknown>,
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
      if (isUnsupportedThreadQueueError(error)) {
        return c.json(
          { error: THREAD_QUEUE_UNSUPPORTED_MESSAGE, unsupported: true },
          501,
        );
      }
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  };
  const itemId = (c: Context) => c.req.param("itemId")?.trim() ?? "";

  app.get("/api/codex/threads/:id/queue", (c) =>
    run(c, async (client, threadId) => {
      if (!client.listThreadQueue) return { supported: false, items: [] };
      return client.listThreadQueue(threadId);
    }),
  );

  app.post("/api/codex/threads/:id/queue", (c) =>
    run(c, async (client, threadId) => {
      const body = await readJsonBody(c);
      const input = parseQueueInputItems(body.input);
      if (!input) return c.json({ error: "input is invalid" }, 400);
      const clientUserMessageId =
        typeof body.clientUserMessageId === "string" &&
        body.clientUserMessageId.trim()
          ? body.clientUserMessageId.trim()
          : randomUUID();
      // An unsupported server is not an error here: the browser falls back
      // to its local queue.
      if (!client.addThreadQueueMessage) return { supported: false };
      try {
        const item = await client.addThreadQueueMessage(
          threadId,
          input,
          clientUserMessageId,
        );
        // Enqueueing onto an idle thread may start it immediately.
        deps.wake?.(threadId);
        return { supported: true, item };
      } catch (error) {
        if (isUnsupportedThreadQueueError(error)) return { supported: false };
        throw error;
      }
    }),
  );

  app.patch("/api/codex/threads/:id/queue/:itemId", (c) =>
    run(c, async (client, threadId) => {
      const body = await readJsonBody(c);
      if (!itemId(c)) return c.json({ error: "item id is required" }, 400);
      if (typeof body.text !== "string" || !body.text.trim())
        return c.json({ error: "text is required" }, 400);
      if (!client.updateThreadQueueMessage)
        return c.json({ error: THREAD_QUEUE_UNSUPPORTED_MESSAGE }, 501);
      return {
        item: await client.updateThreadQueueMessage(
          threadId,
          itemId(c),
          body.text,
        ),
      };
    }),
  );

  app.delete("/api/codex/threads/:id/queue/:itemId", (c) =>
    run(c, async (client, threadId) => {
      if (!itemId(c)) return c.json({ error: "item id is required" }, 400);
      if (!client.deleteThreadQueueMessage)
        return c.json({ error: THREAD_QUEUE_UNSUPPORTED_MESSAGE }, 501);
      return {
        deleted: await client.deleteThreadQueueMessage(threadId, itemId(c)),
      };
    }),
  );

  app.post("/api/codex/threads/:id/queue/reorder", (c) =>
    run(c, async (client, threadId) => {
      const body = await readJsonBody(c);
      const ids = body.ids;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        !ids.every((id) => typeof id === "string" && id.trim()) ||
        new Set(ids).size !== ids.length
      )
        return c.json({ error: "ids must be unique item ids" }, 400);
      if (!client.reorderThreadQueue)
        return c.json({ error: THREAD_QUEUE_UNSUPPORTED_MESSAGE }, 501);
      await client.reorderThreadQueue(
        threadId,
        ids.map((id: string) => id.trim()),
      );
      return { ok: true };
    }),
  );

  app.post("/api/codex/threads/:id/queue/:itemId/move", (c) =>
    run(c, async (client, threadId) => {
      const body = await readJsonBody(c);
      if (!itemId(c)) return c.json({ error: "item id is required" }, 400);
      if (body.direction !== "up" && body.direction !== "down")
        return c.json({ error: "direction must be up or down" }, 400);
      if (!client.moveThreadQueueMessage)
        return c.json({ error: THREAD_QUEUE_UNSUPPORTED_MESSAGE }, 501);
      return {
        moved: await client.moveThreadQueueMessage(
          threadId,
          itemId(c),
          body.direction,
        ),
      };
    }),
  );

  app.post("/api/codex/threads/:id/queue/:itemId/start", (c) =>
    run(c, async (client, threadId) => {
      if (!itemId(c)) return c.json({ error: "item id is required" }, 400);
      if (!client.startThreadQueueMessage)
        return c.json({ error: THREAD_QUEUE_UNSUPPORTED_MESSAGE }, 501);
      const result = await client.startThreadQueueMessage(threadId, itemId(c));
      deps.wake?.(threadId);
      return { ok: true, turnId: result.turnId };
    }),
  );
}
