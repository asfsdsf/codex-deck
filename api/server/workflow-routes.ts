import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getCodexDir } from "../storage";
import { offWorkflowChange, onWorkflowChange } from "../watcher";
import {
  applyWorkflowMerge,
  bindWorkflowSession,
  createWorkflow,
  deleteWorkflow,
  getWorkflowSummaryByKey,
  getWorkflowDaemonStatus,
  getWorkflowBySessionId,
  getWorkflowDetail,
  getWorkflowLog,
  getWorkflowSessionRoles,
  launchWorkflowTask,
  listWorkflows,
  previewWorkflowMerge,
  reconcileWorkflow,
  sendWorkflowControlMessage,
  startWorkflowDaemon,
  stopWorkflowProcesses,
  stopWorkflowDaemon,
  triggerWorkflow,
  validateWorkflow,
} from "../workflows";
import type {
  CreateWorkflowRequest,
  WorkflowActionResponse,
  WorkflowCreateResponse,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowLogResponse,
  WorkflowSessionLookupResult,
  WorkflowSessionRolesRequest,
  WorkflowSessionRolesResponse,
  WorkflowSummary,
  WorkflowControlMessageRequest,
  WorkflowBindSessionRequest,
} from "../storage";
import {
  responseStatusForError,
  toErrorMessage,
  waitForAbortableTimeout,
} from "./utils";

interface WorkflowRouteDependencies {
  workflowRouteUnavailable: (headers: Headers) => boolean;
}

export function registerWorkflowRoutes(
  app: Hono,
  { workflowRouteUnavailable }: WorkflowRouteDependencies,
): void {
  app.get("/api/workflows", async (c) => {
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      const project = c.req.query("project")?.trim() || null;
      const workflows = await listWorkflows();
      const filtered = project
        ? workflows.filter((workflow) => workflow.projectRoot === project)
        : workflows;
      return c.json({ workflows: filtered } satisfies {
        workflows: WorkflowSummary[];
      });
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/workflows/stream", async (c) => {
    if (workflowRouteUnavailable(c.req.raw.headers)) {
      return c.json(
        { error: "Workflow pane is unavailable in remote mode." },
        501,
      );
    }

    return streamSSE(c, async (stream) => {
      let isConnected = true;
      const disconnectController = new AbortController();
      const knownWorkflows = new Map<string, string>();
      const workflowRegistryDir = join(
        getCodexDir(),
        "codex-deck",
        "workflows",
      );

      const cleanup = () => {
        if (!isConnected) {
          return;
        }
        isConnected = false;
        disconnectController.abort();
        offWorkflowChange(handleWorkflowChange);
      };

      const handleWorkflowChange = async (workflowKey: string) => {
        if (!isConnected) {
          return;
        }

        try {
          const summary = await getWorkflowSummaryByKey(
            workflowKey,
            getCodexDir(),
          );
          if (summary) {
            const payload = JSON.stringify(summary);
            if (knownWorkflows.get(workflowKey) === payload) {
              return;
            }
            knownWorkflows.set(workflowKey, payload);
            await stream.writeSSE({
              event: "workflowsUpdate",
              data: JSON.stringify([summary]),
            });
            return;
          }

          const registryPath = join(workflowRegistryDir, `${workflowKey}.json`);
          if (!existsSync(registryPath) && knownWorkflows.has(workflowKey)) {
            knownWorkflows.delete(workflowKey);
            await stream.writeSSE({
              event: "workflowsRemoved",
              data: JSON.stringify({ workflowKeys: [workflowKey] }),
            });
          }
        } catch {
          cleanup();
        }
      };

      onWorkflowChange(handleWorkflowChange);
      stream.onAbort(cleanup);
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });

      try {
        const workflows = await listWorkflows();
        for (const workflow of workflows) {
          knownWorkflows.set(workflow.key, JSON.stringify(workflow));
        }

        await stream.writeSSE({
          event: "workflows",
          data: JSON.stringify(workflows),
        });

        while (isConnected) {
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ timestamp: Date.now() }),
          });
          await waitForAbortableTimeout(30000, disconnectController.signal);
        }
      } catch {
        // Connection closed.
      } finally {
        cleanup();
      }
    });
  });

  app.get("/api/workflows/daemon-status", async (c) => {
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await getWorkflowDaemonStatus()) satisfies WorkflowDaemonStatusResponse,
      );
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/workflows/by-session/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json({
        match: await getWorkflowBySessionId(sessionId),
      } satisfies WorkflowSessionLookupResult);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/session-roles", async (c) => {
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }

      const body = (await c.req
        .json()
        .catch(() => ({}))) as Partial<WorkflowSessionRolesRequest>;
      const sessionIds = Array.isArray(body.sessionIds)
        ? body.sessionIds.filter(
            (sessionId): sessionId is string => typeof sessionId === "string",
          )
        : [];

      return c.json({
        sessions: await getWorkflowSessionRoles(sessionIds),
      } satisfies WorkflowSessionRolesResponse);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/workflows/:key", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await getWorkflowDetail(key)) satisfies WorkflowDetailResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.get("/api/workflows/:key/log", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    const scopeRaw = c.req.query("scope")?.trim() || "scheduler";
    if (
      scopeRaw !== "scheduler" &&
      scopeRaw !== "task" &&
      scopeRaw !== "daemon"
    ) {
      return c.json({ error: "scope must be scheduler, task, or daemon" }, 400);
    }
    const taskId = c.req.query("taskId")?.trim() || null;
    if (scopeRaw === "task" && !taskId) {
      return c.json({ error: "taskId is required for task logs" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await getWorkflowLog(
          key,
          scopeRaw,
          taskId,
        )) satisfies WorkflowLogResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.delete("/api/workflows/:key", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await deleteWorkflow(key)) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/create", async (c) => {
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      const body = (await c.req
        .json()
        .catch(() => ({}))) as Partial<CreateWorkflowRequest>;
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const request =
        typeof body.request === "string" ? body.request.trim() : "";
      if (!title) {
        return c.json({ error: "title is required" }, 400);
      }
      if (!request) {
        return c.json({ error: "request is required" }, 400);
      }
      const response = await createWorkflow({
        title,
        request,
        projectRoot:
          typeof body.projectRoot === "string"
            ? body.projectRoot.trim() || null
            : null,
        workflowId:
          typeof body.workflowId === "string"
            ? body.workflowId.trim() || null
            : null,
        targetBranch:
          typeof body.targetBranch === "string"
            ? body.targetBranch.trim() || null
            : null,
        taskCount: body.taskCount ?? null,
        tasksJson: typeof body.tasksJson === "string" ? body.tasksJson : null,
        sequential: body.sequential === true,
        maxParallel: body.maxParallel ?? null,
      });
      return c.json(response satisfies WorkflowCreateResponse);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/daemon-start", async (c) => {
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await startWorkflowDaemon()) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/daemon-stop", async (c) => {
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await stopWorkflowDaemon()) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/validate", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await validateWorkflow(key)) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/reconcile", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await reconcileWorkflow(key)) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/trigger", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await triggerWorkflow(key)) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/stop-processes", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await stopWorkflowProcesses(key)) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/launch-task", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    const body = (await c.req.json().catch(() => ({}))) as { taskId?: unknown };
    const taskId = typeof body.taskId === "string" ? body.taskId.trim() : "";
    if (!taskId) {
      return c.json({ error: "taskId is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await launchWorkflowTask(
          key,
          taskId,
        )) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/merge-preview", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await previewWorkflowMerge(key)) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/merge-apply", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await applyWorkflowMerge(key)) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/bound-session", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    const body = (await c.req
      .json()
      .catch(() => ({}))) as Partial<WorkflowBindSessionRequest>;
    const sessionId =
      typeof body.sessionId === "string"
        ? body.sessionId.trim() || null
        : body.sessionId === null
          ? null
          : undefined;
    if (sessionId === undefined) {
      return c.json({ error: "sessionId must be a string or null" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await bindWorkflowSession(key, {
          sessionId,
        })) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });

  app.post("/api/workflows/:key/control-message", async (c) => {
    const key = c.req.param("key")?.trim();
    if (!key) {
      return c.json({ error: "workflow key is required" }, 400);
    }
    const body = (await c.req
      .json()
      .catch(() => ({}))) as Partial<WorkflowControlMessageRequest>;
    const type = typeof body.type === "string" ? body.type.trim() : "";
    if (!type) {
      return c.json({ error: "type is required" }, 400);
    }
    try {
      if (workflowRouteUnavailable(c.req.raw.headers)) {
        return c.json(
          { error: "Workflow pane is unavailable in remote mode." },
          501,
        );
      }
      return c.json(
        (await sendWorkflowControlMessage(key, {
          type,
          reason: typeof body.reason === "string" ? body.reason : null,
          payload:
            body.payload &&
            typeof body.payload === "object" &&
            !Array.isArray(body.payload)
              ? (body.payload as Record<string, unknown>)
              : null,
        })) satisfies WorkflowActionResponse,
      );
    } catch (error) {
      const message = toErrorMessage(error);
      return c.json(
        { error: message },
        message.toLowerCase().includes("not found")
          ? 404
          : responseStatusForError(error),
      );
    }
  });
}
