import { stat } from "fs/promises";
import type { Hono } from "hono";
import { getCodexAppServerClient } from "../codex-app-server";
import type {
  SessionHookStateUpdate,
  SessionHooksConfigWriteRequest,
  SessionHooksConfigWriteResponse,
  SessionHooksResponse,
} from "../storage";
import type { RouteContextDependencies } from "./route-helpers";
import { responseStatusForError, toErrorMessage } from "./utils";

function normalizeHookUpdates(
  body: Partial<SessionHooksConfigWriteRequest>,
): SessionHookStateUpdate[] {
  return Array.isArray(body.updates)
    ? body.updates
        .map((update) => {
          if (!update || typeof update !== "object") {
            return null;
          }
          const record = update as unknown as Record<string, unknown>;
          const key = typeof record.key === "string" ? record.key.trim() : "";
          if (!key) {
            return null;
          }
          const enabled =
            typeof record.enabled === "boolean" ? record.enabled : undefined;
          const trustedHash =
            typeof record.trustedHash === "string"
              ? record.trustedHash.trim()
              : record.trustedHash === null
                ? null
                : undefined;
          if (
            enabled === undefined &&
            trustedHash === undefined &&
            trustedHash !== null
          ) {
            return null;
          }
          return {
            key,
            ...(enabled !== undefined ? { enabled } : {}),
            ...(trustedHash !== undefined ? { trustedHash } : {}),
          };
        })
        .filter(
          (
            update,
          ): update is NonNullable<
            SessionHooksConfigWriteRequest["updates"][number]
          > => update !== null,
        )
    : [];
}

async function buildHooksResponse(
  sessionId: string,
  projectPath: string | null,
  unavailableReasonWhenMissing: string,
  unavailableReasonWhenInvalid: string,
) {
  if (!projectPath) {
    const response: SessionHooksResponse = {
      sessionId,
      projectPath: null,
      cwd: null,
      hooks: [],
      warnings: [],
      errors: [],
      unavailableReason: unavailableReasonWhenMissing,
    };
    return response;
  }

  try {
    const projectStat = await stat(projectPath);
    if (!projectStat.isDirectory()) {
      const response: SessionHooksResponse = {
        sessionId,
        projectPath,
        cwd: projectPath,
        hooks: [],
        warnings: [],
        errors: [],
        unavailableReason: unavailableReasonWhenInvalid,
      };
      return response;
    }
  } catch {
    const response: SessionHooksResponse = {
      sessionId,
      projectPath,
      cwd: projectPath,
      hooks: [],
      warnings: [],
      errors: [],
      unavailableReason: unavailableReasonWhenInvalid,
    };
    return response;
  }

  const listHooks = getCodexAppServerClient().listHooks;
  if (typeof listHooks !== "function") {
    throw new Error("Hooks listing is unavailable.");
  }

  const entries = await listHooks({
    cwd: projectPath,
  });
  const selectedEntry =
    entries.find((entry) => entry.cwd === projectPath) ?? entries[0] ?? null;

  const response: SessionHooksResponse = {
    sessionId,
    projectPath,
    cwd: selectedEntry?.cwd ?? projectPath,
    hooks: selectedEntry?.hooks ?? [],
    warnings: selectedEntry?.warnings ?? [],
    errors: selectedEntry?.errors ?? [],
    unavailableReason: null,
  };
  return response;
}

export function registerHooksRoutes(
  app: Hono,
  deps: Pick<
    RouteContextDependencies,
    | "workflowRouteUnavailable"
    | "resolveSessionProjectPath"
    | "resolveWorkflowProjectPath"
  >,
): void {
  app.get("/api/sessions/:id/hooks", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    const projectPath = await deps.resolveSessionProjectPath(sessionId);
    if (projectPath === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    try {
      return c.json(
        await buildHooksResponse(
          sessionId,
          projectPath,
          "Session has no project directory.",
          "Project directory is unavailable.",
        ),
      );
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/workflow-project/:key/hooks", async (c) => {
    const workflowKey = c.req.param("key")?.trim();
    if (!workflowKey) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    if (deps.workflowRouteUnavailable(c.req.raw.headers)) {
      return c.json(
        { error: "Workflow pane is unavailable in remote mode." },
        501,
      );
    }

    const projectPath = await deps.resolveWorkflowProjectPath(workflowKey);
    if (projectPath === undefined) {
      return c.json({ error: "workflow not found" }, 404);
    }

    try {
      return c.json(
        await buildHooksResponse(
          workflowKey,
          projectPath,
          "Workflow has no project directory.",
          "Project directory is unavailable.",
        ),
      );
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/sessions/:id/hooks/config", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    if ((await deps.resolveSessionProjectPath(sessionId)) === undefined) {
      return c.json({ error: "session not found" }, 404);
    }

    let body: Partial<SessionHooksConfigWriteRequest>;
    try {
      body = (await c.req.json()) as Partial<SessionHooksConfigWriteRequest>;
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }

    const updates = normalizeHookUpdates(body);
    if (updates.length === 0) {
      return c.json({ error: "updates are required" }, 400);
    }

    const writeHookState = getCodexAppServerClient().writeHookState;
    if (typeof writeHookState !== "function") {
      return c.json(
        {
          error: "Hook configuration updates are unavailable.",
        },
        501,
      );
    }

    try {
      await writeHookState(updates);
      const response: SessionHooksConfigWriteResponse = {
        sessionId,
        updates,
        ok: true,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflow-project/:key/hooks/config", async (c) => {
    const workflowKey = c.req.param("key")?.trim();
    if (!workflowKey) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    if (deps.workflowRouteUnavailable(c.req.raw.headers)) {
      return c.json(
        { error: "Workflow pane is unavailable in remote mode." },
        501,
      );
    }

    if ((await deps.resolveWorkflowProjectPath(workflowKey)) === undefined) {
      return c.json({ error: "workflow not found" }, 404);
    }

    let body: Partial<SessionHooksConfigWriteRequest>;
    try {
      body = (await c.req.json()) as Partial<SessionHooksConfigWriteRequest>;
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }

    const updates = normalizeHookUpdates(body);
    if (updates.length === 0) {
      return c.json({ error: "updates are required" }, 400);
    }

    const writeHookState = getCodexAppServerClient().writeHookState;
    if (typeof writeHookState !== "function") {
      return c.json(
        {
          error: "Hook configuration updates are unavailable.",
        },
        501,
      );
    }

    try {
      await writeHookState(updates);
      const response: SessionHooksConfigWriteResponse = {
        sessionId: workflowKey,
        updates,
        ok: true,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });
}
