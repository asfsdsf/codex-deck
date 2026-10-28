import type { Context, Hono } from "hono";
import {
  getCodexAppServerClient,
  type CodexAppServerClientFacade,
} from "../codex-app-server";
import {
  changeThreadWorkingDirectory,
  CodexWorkspaceError,
} from "../codex-working-directory";
import {
  parseApprovalPolicy,
  parseApprovalsReviewer,
} from "../codex-permissions";
import { responseStatusForError, toErrorMessage } from "./utils";

type WorkspaceClient = Pick<
  CodexAppServerClientFacade,
  | "getThreadSummary"
  | "listBackgroundTerminals"
  | "forkThread"
  | "archiveThread"
  | "readPermissions"
  | "applyPermissions"
  | "readGuardianReviews"
  | "approveGuardianDenial"
  | "listWorktrees"
  | "startWorktree"
  | "removeWorktree"
>;

export function registerWorkspaceRoutes(
  app: Hono,
  deps: {
    subscribe?: () => void;
    getClient?: () => WorkspaceClient;
  } = {},
) {
  const run = async (
    c: Context,
    work: (client: WorkspaceClient) => Promise<unknown>,
  ) => {
    try {
      deps.subscribe?.();
      const result = await work((deps.getClient ?? getCodexAppServerClient)());
      return result instanceof Response ? result : c.json(result);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        error instanceof CodexWorkspaceError
          ? error.status
          : responseStatusForError(error),
      );
    }
  };

  app.post("/api/codex/threads/:id/working-directory", (c) =>
    run(c, async (client) => {
      const threadId = c.req.param("id")?.trim();
      const body = await c.req.json().catch(() => null);
      if (
        !threadId ||
        !body ||
        typeof body.path !== "string" ||
        (body.currentCwd != null && typeof body.currentCwd !== "string")
      )
        return c.json(
          { error: "Thread ID and a directory path are required." },
          400,
        );
      if (!client.getThreadSummary || !client.forkThread)
        throw new Error("Changing directories is unavailable on this server.");
      return changeThreadWorkingDirectory(
        {
          getThreadSummary: client.getThreadSummary,
          forkThread: client.forkThread,
          archiveThread: client.archiveThread,
          hasBackgroundTerminals: client.listBackgroundTerminals
            ? async (id) =>
                (await client.listBackgroundTerminals!(id)).length > 0
            : undefined,
        },
        threadId,
        body.path,
        body.currentCwd,
      );
    }),
  );

  app.get("/api/codex/threads/:id/permissions", (c) =>
    run(c, async (client) => {
      const threadId = c.req.param("id")?.trim();
      if (!threadId) return c.json({ error: "Thread ID is required." }, 400);
      if (!client.readPermissions)
        throw new Error("Permission settings are unavailable on this server.");
      return client.readPermissions(threadId);
    }),
  );

  app.post("/api/codex/threads/:id/permissions", (c) =>
    run(c, async (client) => {
      const threadId = c.req.param("id")?.trim();
      const body = await c.req.json().catch(() => null);
      const approvalPolicy =
        body?.approvalPolicy == null
          ? null
          : parseApprovalPolicy(body.approvalPolicy);
      const approvalsReviewer =
        body?.approvalsReviewer == null
          ? null
          : parseApprovalsReviewer(body.approvalsReviewer);
      if (
        !threadId ||
        typeof body?.profileId !== "string" ||
        !body.profileId.trim() ||
        (body.approvalPolicy != null && !approvalPolicy) ||
        (body.approvalsReviewer != null && !approvalsReviewer)
      )
        return c.json(
          {
            error:
              "A permission profile and optional valid approval policy and reviewer are required.",
          },
          400,
        );
      if (!client.applyPermissions)
        throw new Error("Permission settings are unavailable on this server.");
      return client.applyPermissions(threadId, {
        profileId: body.profileId,
        approvalPolicy,
        approvalsReviewer,
      });
    }),
  );

  app.get("/api/codex/threads/:id/auto-review", (c) =>
    run(c, async (client) => {
      const threadId = c.req.param("id")?.trim();
      if (!threadId) return c.json({ error: "Thread ID is required." }, 400);
      if (!client.readGuardianReviews)
        throw new Error("Auto-review activity is unavailable on this server.");
      return client.readGuardianReviews(threadId);
    }),
  );

  app.post("/api/codex/threads/:id/auto-review/:reviewId/approve", (c) =>
    run(c, async (client) => {
      const threadId = c.req.param("id")?.trim();
      const reviewId = c.req.param("reviewId")?.trim();
      if (!threadId || !reviewId)
        return c.json({ error: "Thread and review IDs are required." }, 400);
      if (!client.approveGuardianDenial)
        throw new Error("Auto-review retries are unavailable on this server.");
      return client.approveGuardianDenial(threadId, reviewId);
    }),
  );

  app.get("/api/codex/threads/:id/worktrees", (c) =>
    run(c, async (client) => {
      const threadId = c.req.param("id")?.trim();
      if (!threadId) return c.json({ error: "Thread ID is required." }, 400);
      if (!client.listWorktrees)
        throw new Error("Managed worktrees are unavailable on this server.");
      return client.listWorktrees(threadId, c.req.query("cwd") || null);
    }),
  );

  app.post("/api/codex/threads/:id/worktrees", (c) =>
    run(c, async (client) => {
      const threadId = c.req.param("id")?.trim();
      const body = await c.req.json().catch(() => null);
      if (
        !threadId ||
        (body?.mode !== "fork" && body?.mode !== "new") ||
        (body.currentCwd != null && typeof body.currentCwd !== "string")
      )
        return c.json(
          { error: "Thread ID and a mode of fork or new are required." },
          400,
        );
      if (!client.startWorktree)
        throw new Error("Managed worktrees are unavailable on this server.");
      return client.startWorktree(threadId, body.mode, body.currentCwd);
    }),
  );

  app.post("/api/codex/threads/:id/worktrees/remove", (c) =>
    run(c, async (client) => {
      const threadId = c.req.param("id")?.trim();
      const body = await c.req.json().catch(() => null);
      if (
        !threadId ||
        typeof body?.root !== "string" ||
        !body.root.trim() ||
        (body.currentCwd != null && typeof body.currentCwd !== "string")
      )
        return c.json(
          { error: "Thread ID and a worktree root are required." },
          400,
        );
      if (!client.removeWorktree)
        throw new Error("Managed worktrees are unavailable on this server.");
      return client.removeWorktree(threadId, body.root, body.currentCwd);
    }),
  );
}
