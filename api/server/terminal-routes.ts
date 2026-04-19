import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getCodexAppServerClient } from "../codex-app-server";
import { getLocalTerminalManager } from "../local-terminal";
import { getSystemContextSnapshot } from "../system-context";
import { sanitizeTerminalChatTranscript } from "../terminal-chat-transcript-sanitizer";
import {
  buildTerminalBoundUserMessageText,
  buildTerminalChatBootstrapMessage,
  type FrozenTerminalCommandContext,
} from "../terminal-chat-context";
import {
  buildTerminalSkillInstallMessagePrefix,
  getTerminalSkillAvailability,
} from "../terminal-skill-install";
import {
  clearTerminalBinding,
  getTerminalBinding,
  getTerminalBindingsByTerminalIds,
  getTerminalSessionRoles,
  onTerminalBindingChange,
  setTerminalBinding,
  TerminalBindingConflictError,
} from "../terminal-bindings";
import {
  persistTerminalSessionFrozenBlock,
  persistTerminalSessionMessageAction,
  removeTerminalSessionArtifacts,
} from "../terminal-session-store";
import {
  buildEmptyTerminalSessionArtifacts,
  clearTerminalSessionSyncState,
  syncTerminalSessionArtifacts,
  syncTrackedTerminalSessionArtifacts,
} from "../terminal-session-sync";
import { onSessionChange } from "../watcher";
import type {
  CreateTerminalRequest,
  TerminalBindSessionRequest,
  TerminalBindingResponse,
  TerminalClaimWriteRequest,
  TerminalCommandResponse,
  TerminalChatActionRequest,
  TerminalChatActionResponse,
  TerminalChatActionCompletedResponse,
  TerminalChatActionNeedsSkillInstallResponse,
  TerminalEventsResponse,
  TerminalInputRequest,
  TerminalInputResponse,
  TerminalListResponse,
  TerminalReleaseWriteRequest,
  TerminalPersistMessageActionRequest,
  TerminalPersistMessageActionResponse,
  TerminalResizeRequest,
  TerminalSessionRolesRequest,
  TerminalSessionRolesResponse,
  TerminalSessionArtifactsResponse,
  TerminalSnapshotResponse,
  TerminalStreamEvent,
  TerminalSummary,
} from "../storage";
import {
  MAX_LONG_POLL_WAIT_MS,
  parseNonNegativeInteger,
  responseStatusForError,
  toErrorMessage,
  waitForAbortableTimeout,
} from "./utils";

let terminalArtifactWatchersInstalled = false;
const VALID_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function parseOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function parseOptionalEffort(
  value: unknown,
): TerminalChatActionRequest["effort"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "string" && VALID_REASONING_EFFORTS.has(value)
    ? value
    : undefined;
}

function parseOptionalCollaborationMode(
  value: unknown,
): TerminalChatActionRequest["collaborationMode"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const mode =
    "mode" in value && typeof value.mode === "string" ? value.mode.trim() : "";
  if (!mode) {
    return undefined;
  }

  const settingsValue =
    "settings" in value ? (value.settings as Record<string, unknown>) : undefined;
  if (settingsValue !== undefined && (typeof settingsValue !== "object" || settingsValue === null)) {
    return undefined;
  }

  const model = parseOptionalString(settingsValue?.model);
  if (settingsValue && "model" in settingsValue && model === undefined) {
    return undefined;
  }

  const reasoningEffort = parseOptionalEffort(settingsValue?.reasoningEffort);
  if (
    settingsValue &&
    "reasoningEffort" in settingsValue &&
    reasoningEffort === undefined
  ) {
    return undefined;
  }

  const developerInstructions = parseOptionalString(
    settingsValue?.developerInstructions,
  );
  if (
    settingsValue &&
    "developerInstructions" in settingsValue &&
    developerInstructions === undefined
  ) {
    return undefined;
  }

  const normalizedSettings =
    settingsValue === undefined
      ? undefined
      : {
          ...(model !== undefined ? { model } : {}),
          ...(reasoningEffort !== undefined
            ? { reasoningEffort }
            : {}),
          ...(developerInstructions !== undefined
            ? { developerInstructions }
            : {}),
        };

  return {
    mode,
    ...(normalizedSettings ? { settings: normalizedSettings } : {}),
  };
}

function toTerminalTextInput(text: string): Array<{ type: "text"; text: string }> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return [];
  }
  return [{ type: "text", text: normalizedText }];
}

async function consumeFrozenTerminalContext(
  terminalId: string,
  sessionId: string,
): Promise<FrozenTerminalCommandContext | null> {
  const manager = getLocalTerminalManager();
  const capture = await manager.consumeFrozenBlock(terminalId);
  if (!capture) {
    return null;
  }

  await persistTerminalSessionFrozenBlock({
    terminalId,
    sessionId,
    captureKind: "manual",
    snapshot: capture.snapshot,
  });
  void publishTerminalArtifactsForBinding(terminalId).catch(() => {});

  const transcript = capture.transcript?.trim() ?? "";
  if (!transcript) {
    return null;
  }
  const sanitizedTranscript = await sanitizeTerminalChatTranscript(transcript, {
    cols: capture.snapshot.cols,
    rows: capture.snapshot.rows,
  });
  if (!sanitizedTranscript) {
    return null;
  }
  return {
    terminalId,
    transcript: sanitizedTranscript,
  };
}

async function loadTerminalArtifacts(
  terminalId: string,
): Promise<TerminalSessionArtifactsResponse | null> {
  const binding = await getTerminalBinding(terminalId);
  const sessionId = binding.boundSessionId?.trim() ?? "";
  if (!sessionId) {
    return null;
  }

  const manager = getLocalTerminalManager();
  if (!manager.getSnapshot(terminalId)) {
    return null;
  }

  return syncTerminalSessionArtifacts({
    terminalId,
    sessionId,
  });
}

async function publishTerminalArtifactsForBinding(
  terminalId: string,
): Promise<void> {
  const manager = getLocalTerminalManager();
  if (!manager.getSnapshot(terminalId)) {
    return;
  }

  const binding = await getTerminalBinding(terminalId);
  const sessionId = binding.boundSessionId?.trim() ?? "";
  if (!sessionId) {
    clearTerminalSessionSyncState(terminalId);
    manager.publishArtifacts(
      terminalId,
      buildEmptyTerminalSessionArtifacts(terminalId),
    );
    return;
  }

  if (!manager.getSnapshot(terminalId)) {
    return;
  }

  const result = await syncTrackedTerminalSessionArtifacts({
    terminalId,
    sessionId,
  });
  if (result.changed) {
    manager.publishArtifacts(terminalId, result.artifacts);
  }
}

function ensureTerminalArtifactWatchers(): void {
  if (terminalArtifactWatchersInstalled) {
    return;
  }
  terminalArtifactWatchersInstalled = true;

  onSessionChange((sessionId) => {
    void (async () => {
      const manager = getLocalTerminalManager();
      const terminals = manager.listTerminals();
      if (terminals.length === 0) {
        return;
      }
      const bindings = await getTerminalBindingsByTerminalIds(
        terminals.map((terminal) => terminal.terminalId),
      );
      await Promise.all(
        terminals.map(async (terminal) => {
          if (bindings[terminal.terminalId] !== sessionId) {
            return;
          }
          await publishTerminalArtifactsForBinding(terminal.terminalId);
        }),
      );
    })().catch(() => {});
  });

  onTerminalBindingChange(() => {
    const manager = getLocalTerminalManager();
    for (const terminal of manager.listTerminals()) {
      void publishTerminalArtifactsForBinding(terminal.terminalId).catch(
        () => {},
      );
    }
  });
}

function toTerminalCommandResponse(
  terminalId: string,
  snapshot: {
    running: boolean;
    seq: number;
    writeOwnerId: string | null;
  },
): TerminalCommandResponse {
  return {
    ok: true,
    id: terminalId,
    terminalId,
    running: snapshot.running,
    seq: snapshot.seq,
    writeOwnerId: snapshot.writeOwnerId,
  };
}

async function withTerminalBindings(
  terminals: TerminalSummary[],
): Promise<TerminalSummary[]> {
  if (terminals.length === 0) {
    return [];
  }
  const bindings = await getTerminalBindingsByTerminalIds(
    terminals.map((terminal) => terminal.terminalId),
  );
  return terminals.map((terminal) => ({
    ...terminal,
    boundSessionId: bindings[terminal.terminalId] ?? null,
  }));
}

function buildCompletedTerminalChatActionResponse(input: {
  action: TerminalChatActionRequest["action"];
  terminalId: string;
  sessionId: string;
  boundSessionId: string | null;
  turnId: string | null;
  createdSession: boolean;
}): TerminalChatActionCompletedResponse {
  return {
    status: "completed",
    action: input.action,
    terminalId: input.terminalId,
    sessionId: input.sessionId,
    boundSessionId: input.boundSessionId,
    turnId: input.turnId,
    createdSession: input.createdSession,
  };
}

function buildNeedsSkillInstallResponse(input: {
  action: "init" | "chat-in-session";
  terminalId: string;
  projectRoot: string;
}): TerminalChatActionNeedsSkillInstallResponse {
  return {
    status: "needs_skill_install",
    action: input.action,
    terminalId: input.terminalId,
    projectRoot: input.projectRoot,
  };
}

export function registerTerminalRoutes(app: Hono): void {
  ensureTerminalArtifactWatchers();

  app.get("/api/terminals", async (c) => {
    try {
      const manager = getLocalTerminalManager();
      return c.json({
        terminals: await withTerminalBindings(manager.listTerminals()),
      } satisfies TerminalListResponse);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals", async (c) => {
    try {
      const body = (await c.req
        .json()
        .catch(() => ({}))) as Partial<CreateTerminalRequest>;
      if (body.cwd !== undefined && typeof body.cwd !== "string") {
        return c.json({ error: "cwd must be a string" }, 400);
      }
      const manager = getLocalTerminalManager();
      return c.json(manager.createTerminal(body.cwd));
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/terminals/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      const manager = getLocalTerminalManager();
      let isConnected = true;
      const disconnectController = new AbortController();
      let unsubscribeTerminals: (() => void) | null = null;
      let unsubscribeBindings: (() => void) | null = null;

      const cleanup = () => {
        if (!isConnected) {
          return;
        }
        isConnected = false;
        disconnectController.abort();
        if (unsubscribeTerminals) {
          unsubscribeTerminals();
          unsubscribeTerminals = null;
        }
        if (unsubscribeBindings) {
          unsubscribeBindings();
          unsubscribeBindings = null;
        }
      };

      const writeTerminals = async (terminals: TerminalSummary[]) => {
        if (!isConnected) {
          return;
        }
        try {
          await stream.writeSSE({
            event: "terminals",
            data: JSON.stringify(await withTerminalBindings(terminals)),
          });
        } catch {
          cleanup();
        }
      };

      await writeTerminals(manager.listTerminals());
      unsubscribeTerminals = manager.subscribeTerminals((terminals) => {
        void writeTerminals(terminals);
      });
      unsubscribeBindings = onTerminalBindingChange(() => {
        void writeTerminals(manager.listTerminals());
      });
      stream.onAbort(cleanup);
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });

      while (isConnected) {
        await waitForAbortableTimeout(30000, disconnectController.signal);
      }
    });
  });

  app.post("/api/terminals/:terminalId/message-action", async (c) => {
    try {
      const terminalId = c.req.param("terminalId")?.trim();
      if (!terminalId) {
        return c.json({ error: "terminal id is required" }, 400);
      }

      const manager = getLocalTerminalManager();
      if (!manager.getSnapshot(terminalId)) {
        return c.json({ error: "terminal not found" }, 404);
      }

      const body = (await c.req
        .json()
        .catch(() => ({}))) as Partial<TerminalPersistMessageActionRequest>;
      const sessionId = body.sessionId?.trim();
      const messageKey = body.messageKey?.trim();
      const stepId = body.stepId?.trim();
      const decision = body.decision;
      const reason =
        body.reason === undefined || body.reason === null
          ? null
          : typeof body.reason === "string"
            ? body.reason
            : undefined;

      if (!sessionId) {
        return c.json({ error: "sessionId is required" }, 400);
      }
      if (!messageKey) {
        return c.json({ error: "messageKey is required" }, 400);
      }
      if (!stepId) {
        return c.json({ error: "stepId is required" }, 400);
      }
      if (decision !== "approved" && decision !== "rejected") {
        return c.json({ error: "decision must be approved or rejected" }, 400);
      }
      if (reason === undefined) {
        return c.json({ error: "reason must be a string or null" }, 400);
      }

      await syncTrackedTerminalSessionArtifacts({
        terminalId,
        sessionId,
      });

      const response = await persistTerminalSessionMessageAction({
          terminalId,
          sessionId,
          messageKey,
          stepId,
          decision,
          reason,
        });
      void publishTerminalArtifactsForBinding(terminalId).catch(() => {});
      return c.json(response satisfies TerminalPersistMessageActionResponse);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals/:terminalId/chat-action", async (c) => {
    try {
      const terminalId = c.req.param("terminalId")?.trim();
      if (!terminalId) {
        return c.json({ error: "terminal id is required" }, 400);
      }

      const manager = getLocalTerminalManager();
      const terminal = manager.getSnapshot(terminalId);
      if (!terminal) {
        return c.json({ error: "terminal not found" }, 404);
      }

      const body = (await c.req
        .json()
        .catch(() => ({}))) as Partial<TerminalChatActionRequest>;
      const action = body.action?.trim();
      if (
        action !== "send" &&
        action !== "init" &&
        action !== "chat-in-session"
      ) {
        return c.json(
          { error: "action must be send, init, or chat-in-session" },
          400,
        );
      }

      if (body.text !== undefined && typeof body.text !== "string") {
        return c.json({ error: "text must be a string" }, 400);
      }
      if (
        body.images !== undefined &&
        (!Array.isArray(body.images) ||
          body.images.some((image) => typeof image !== "string"))
      ) {
        return c.json({ error: "images must be an array of strings" }, 400);
      }

      const model = parseOptionalString(body.model);
      if (body.model !== undefined && model === undefined) {
        return c.json({ error: "model must be a string or null" }, 400);
      }

      const effort = parseOptionalEffort(body.effort);
      if (body.effort !== undefined && effort === undefined) {
        return c.json({ error: "effort is invalid" }, 400);
      }

      const collaborationMode = parseOptionalCollaborationMode(
        body.collaborationMode,
      );
      if (
        body.collaborationMode !== undefined &&
        collaborationMode === undefined
      ) {
        return c.json({ error: "collaborationMode is invalid" }, 400);
      }

      const skillInstallChoice = body.skillInstallChoice;
      if (
        skillInstallChoice !== undefined &&
        skillInstallChoice !== null &&
        skillInstallChoice !== "local" &&
        skillInstallChoice !== "global"
      ) {
        return c.json(
          { error: "skillInstallChoice must be local, global, or null" },
          400,
        );
      }

      const normalizedImages = (body.images ?? []).filter(
        (image) => image.trim().length > 0,
      );
      const normalizedText = body.text?.trim() ?? "";
      const binding = await getTerminalBinding(terminalId);
      const boundSessionId = binding.boundSessionId?.trim() ?? "";

      if (action === "send") {
        if (!boundSessionId) {
          return c.json(
            { error: "terminal is not bound to a session" },
            409,
          );
        }

        const terminalContext = await consumeFrozenTerminalContext(
          terminalId,
          boundSessionId,
        );
        const text = buildTerminalBoundUserMessageText({
          text: normalizedText,
          terminalContext,
        });
        const input = [
          ...toTerminalTextInput(text),
          ...normalizedImages.map((url) => ({ type: "image", url }) as const),
        ];
        if (input.length === 0) {
          return c.json(
            {
              error: "text, images, or a frozen terminal block is required",
            },
            400,
          );
        }

        const result = await getCodexAppServerClient().sendMessage({
          threadId: boundSessionId,
          input,
          ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(collaborationMode !== undefined ? { collaborationMode } : {}),
        });

        const response: TerminalChatActionResponse =
          buildCompletedTerminalChatActionResponse({
            action,
            terminalId,
            sessionId: boundSessionId,
            boundSessionId,
            turnId: result.turnId,
            createdSession: false,
          });
        return c.json(response);
      }

      if (boundSessionId) {
        const response: TerminalChatActionResponse =
          buildCompletedTerminalChatActionResponse({
            action,
            terminalId,
            sessionId: boundSessionId,
            boundSessionId,
            turnId: null,
            createdSession: false,
          });
        return c.json(response);
      }

      const listSkills = getCodexAppServerClient().listSkills;
      if (typeof listSkills !== "function") {
        return c.json({ error: "Skills listing is unavailable." }, 501);
      }

      const skillEntries = await listSkills({
        cwd: terminal.cwd,
      });
      const selectedSkillEntry =
        skillEntries.find((entry) => entry.cwd === terminal.cwd) ??
        skillEntries[0] ??
        null;
      const availability = getTerminalSkillAvailability(
        selectedSkillEntry?.skills ?? [],
        terminal.cwd,
      );
      if (!availability.isInstalled && !skillInstallChoice) {
        const response: TerminalChatActionResponse =
          buildNeedsSkillInstallResponse({
            action,
            terminalId,
            projectRoot: terminal.cwd,
          });
        return c.json(response);
      }

      const createdThreadId = await getCodexAppServerClient().createThread({
        cwd: terminal.cwd,
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      });
      const terminalContext = await consumeFrozenTerminalContext(
        terminalId,
        createdThreadId,
      );
      const system = getSystemContextSnapshot();
      const bootstrapMessage = buildTerminalChatBootstrapMessage({
        terminalId,
        cwd: terminal.cwd,
        shell: terminal.shell.trim() || system.defaultShell || "sh",
        osName: system.osName,
        osRelease: system.osRelease,
        architecture: system.architecture,
        platform: system.platform,
        initialUserMessage: normalizedText,
        imageCount: normalizedImages.length,
        terminalContext,
      });
      const skillInstallPrefix =
        availability.isInstalled || !skillInstallChoice
          ? ""
          : buildTerminalSkillInstallMessagePrefix(skillInstallChoice);
      const result = await getCodexAppServerClient().sendMessage({
        threadId: createdThreadId,
        input: [
          {
            type: "text",
            text: `${skillInstallPrefix}${bootstrapMessage}`,
          },
          ...normalizedImages.map((url) => ({ type: "image", url }) as const),
        ],
        ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      });

      const terminalBinding = await setTerminalBinding(terminalId, createdThreadId);
      void publishTerminalArtifactsForBinding(terminalId).catch(() => {});
      const response: TerminalChatActionResponse =
        buildCompletedTerminalChatActionResponse({
          action,
          terminalId,
          sessionId: createdThreadId,
          boundSessionId: terminalBinding.boundSessionId,
          turnId: result.turnId,
          createdSession: true,
        });
      return c.json(response);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals/:terminalId/binding", async (c) => {
    try {
      const terminalId = c.req.param("terminalId")?.trim();
      if (!terminalId) {
        return c.json({ error: "terminal id is required" }, 400);
      }

      const manager = getLocalTerminalManager();
      if (!manager.getSnapshot(terminalId)) {
        return c.json({ error: "terminal not found" }, 404);
      }

      const body = (await c.req
        .json()
        .catch(() => ({}))) as Partial<TerminalBindSessionRequest>;
      const rawSessionId = body.sessionId;
      if (
        rawSessionId !== undefined &&
        rawSessionId !== null &&
        typeof rawSessionId !== "string"
      ) {
        return c.json({ error: "sessionId must be a string or null" }, 400);
      }

      const binding = await setTerminalBinding(
        terminalId,
        typeof rawSessionId === "string" ? rawSessionId : null,
      );
      void publishTerminalArtifactsForBinding(terminalId).catch(() => {});
      if (!binding.boundSessionId) {
        const snapshot = manager.getSnapshot(terminalId);
        if (snapshot && !snapshot.running) {
          await manager.closeTerminal(terminalId);
        }
      }

      return c.json(binding satisfies TerminalBindingResponse);
    } catch (error) {
      if (error instanceof TerminalBindingConflictError) {
        return c.json({ error: error.message }, 409);
      }
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals/session-roles", async (c) => {
    try {
      const body = (await c.req
        .json()
        .catch(() => ({}))) as Partial<TerminalSessionRolesRequest>;
      const sessionIds = Array.isArray(body.sessionIds)
        ? body.sessionIds.filter(
            (sessionId): sessionId is string => typeof sessionId === "string",
          )
        : [];

      return c.json({
        sessions: await getTerminalSessionRoles(sessionIds),
      } satisfies TerminalSessionRolesResponse);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.delete("/api/terminals/:terminalId", async (c) => {
    try {
      const terminalId = c.req.param("terminalId");
      const manager = getLocalTerminalManager();
      const closed = await manager.closeTerminal(terminalId);
      if (!closed) {
        return c.json({ error: "terminal not found" }, 404);
      }
      await clearTerminalBinding(terminalId);
      clearTerminalSessionSyncState(terminalId);
      await removeTerminalSessionArtifacts(terminalId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals/:terminalId/input", async (c) => {
    try {
      const terminalId = c.req.param("terminalId");
      const body = (await c.req.json()) as Partial<TerminalInputRequest>;
      if (typeof body.input !== "string") {
        return c.json({ error: "input must be a string" }, 400);
      }

      const clientId = c.req.query("clientId");
      const manager = getLocalTerminalManager();
      const snapshot = manager.getSnapshot(terminalId);
      if (!snapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      let currentOwner = manager.getWriteOwnerId(terminalId);
      if (!currentOwner && clientId?.trim()) {
        manager.claimWrite(terminalId, clientId.trim());
        currentOwner = manager.getWriteOwnerId(terminalId);
      }
      if (currentOwner && clientId !== currentOwner) {
        return c.json({ error: "another client owns terminal write" }, 403);
      }

      const startSeq = snapshot.seq;
      const startOffset = snapshot.output.length;
      manager.writeInput(terminalId, body.input);
      const nextSnapshot = manager.getSnapshot(terminalId);
      if (!nextSnapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      return c.json({
        ...toTerminalCommandResponse(nextSnapshot.terminalId, nextSnapshot),
        startSeq,
        startOffset,
      } satisfies TerminalInputResponse);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals/:terminalId/resize", async (c) => {
    try {
      const terminalId = c.req.param("terminalId");
      const body = (await c.req.json()) as Partial<TerminalResizeRequest>;
      const cols = parseNonNegativeInteger(body.cols);
      const rows = parseNonNegativeInteger(body.rows);

      if (!cols || cols < 2) {
        return c.json({ error: "cols must be an integer >= 2" }, 400);
      }
      if (!rows || rows < 2) {
        return c.json({ error: "rows must be an integer >= 2" }, 400);
      }

      const clientId = c.req.query("clientId");
      const manager = getLocalTerminalManager();
      const snapshot = manager.getSnapshot(terminalId);
      if (!snapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      const currentOwner = manager.getWriteOwnerId(terminalId);
      if (!currentOwner) {
        return c.json({ error: "terminal write permission is required" }, 403);
      }
      if (clientId !== currentOwner) {
        return c.json({ error: "another client owns terminal write" }, 403);
      }

      manager.resize(terminalId, cols, rows);
      const nextSnapshot = manager.getSnapshot(terminalId);
      if (!nextSnapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      return c.json(
        toTerminalCommandResponse(nextSnapshot.terminalId, nextSnapshot),
      );
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals/:terminalId/restart", async (c) => {
    try {
      const terminalId = c.req.param("terminalId");
      const clientId = c.req.query("clientId");
      const manager = getLocalTerminalManager();
      const currentOwner = manager.getWriteOwnerId(terminalId);
      if (currentOwner && clientId !== currentOwner) {
        return c.json({ error: "another client owns terminal write" }, 403);
      }

      const snapshot = manager.restart(terminalId);
      if (!snapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      return c.json(snapshot satisfies TerminalSnapshotResponse);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals/:terminalId/claim-write", async (c) => {
    try {
      const terminalId = c.req.param("terminalId");
      const body = (await c.req.json()) as Partial<TerminalClaimWriteRequest>;
      if (typeof body.clientId !== "string" || !body.clientId.trim()) {
        return c.json({ error: "clientId must be a non-empty string" }, 400);
      }

      const manager = getLocalTerminalManager();
      if (!manager.getSnapshot(terminalId)) {
        return c.json({ error: "terminal not found" }, 404);
      }
      manager.claimWrite(terminalId, body.clientId);
      const snapshot = manager.getSnapshot(terminalId);
      if (!snapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      return c.json(toTerminalCommandResponse(snapshot.terminalId, snapshot));
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/terminals/:terminalId/release-write", async (c) => {
    try {
      const terminalId = c.req.param("terminalId");
      const body = (await c.req.json()) as Partial<TerminalReleaseWriteRequest>;
      if (typeof body.clientId !== "string" || !body.clientId.trim()) {
        return c.json({ error: "clientId must be a non-empty string" }, 400);
      }

      const manager = getLocalTerminalManager();
      if (!manager.getSnapshot(terminalId)) {
        return c.json({ error: "terminal not found" }, 404);
      }
      manager.releaseWrite(terminalId, body.clientId);
      const snapshot = manager.getSnapshot(terminalId);
      if (!snapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      return c.json(toTerminalCommandResponse(snapshot.terminalId, snapshot));
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/terminals/:terminalId/events", async (c) => {
    const terminalId = c.req.param("terminalId");
    const fromSeqRaw = c.req.query("fromSeq");
    const fromSeq = fromSeqRaw ? parseNonNegativeInteger(fromSeqRaw) : 0;
    if (fromSeqRaw !== undefined && fromSeq === null) {
      return c.json({ error: "fromSeq must be a non-negative integer" }, 400);
    }

    const waitMsRaw = c.req.query("waitMs");
    const parsedWaitMs = waitMsRaw ? parseNonNegativeInteger(waitMsRaw) : 0;
    if (waitMsRaw !== undefined && parsedWaitMs === null) {
      return c.json({ error: "waitMs must be a non-negative integer" }, 400);
    }
    const waitMs = Math.min(parsedWaitMs ?? 0, MAX_LONG_POLL_WAIT_MS);
    const includeBootstrap = c.req.query("bootstrap") === "1";

    try {
      const manager = getLocalTerminalManager();
      if (!manager.getSnapshot(terminalId)) {
        return c.json({ error: "terminal not found" }, 404);
      }
      const normalizedFromSeq = fromSeq ?? 0;
      let eventBatch = manager.getEventsSince(terminalId, normalizedFromSeq);
      if (!eventBatch) {
        return c.json({ error: "terminal not found" }, 404);
      }

      if (
        waitMs > 0 &&
        !eventBatch.requiresReset &&
        eventBatch.events.length === 0
      ) {
        await new Promise<void>((resolve) => {
          let settled = false;
          let timeout: NodeJS.Timeout | null = null;
          let unsubscribe: (() => void) | null = null;

          const cleanup = () => {
            if (timeout) {
              clearTimeout(timeout);
            }
            if (unsubscribe) {
              unsubscribe();
            }
            c.req.raw.signal.removeEventListener("abort", handleAbort);
          };

          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            resolve();
          };

          const handleAbort = () => {
            finish();
          };

          timeout = setTimeout(() => {
            finish();
          }, waitMs);
          unsubscribe = manager.subscribeTerminal(terminalId, (event) => {
            if (event.seq > normalizedFromSeq) {
              finish();
            }
          });
          c.req.raw.signal.addEventListener("abort", handleAbort, {
            once: true,
          });
        });

        eventBatch = manager.getEventsSince(terminalId, normalizedFromSeq);
        if (!eventBatch) {
          return c.json({ error: "terminal not found" }, 404);
        }
      }

      return c.json({
        events: eventBatch.events,
        requiresReset: eventBatch.requiresReset,
        snapshot: eventBatch.requiresReset
          ? manager.getSnapshot(terminalId)
          : null,
        bootstrap: includeBootstrap
          ? {
              snapshot: manager.getSnapshot(terminalId)!,
              artifacts: await loadTerminalArtifacts(terminalId),
            }
          : null,
      } satisfies TerminalEventsResponse);
    } catch (error) {
      return c.json(
        { error: toErrorMessage(error) },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/terminals/:terminalId/stream", async (c) => {
    const terminalId = c.req.param("terminalId");
    const fromSeqRaw = c.req.query("fromSeq");
    const fromSeq = fromSeqRaw ? parseNonNegativeInteger(fromSeqRaw) : 0;
    if (fromSeqRaw !== undefined && fromSeq === null) {
      return c.json({ error: "fromSeq must be a non-negative integer" }, 400);
    }
    const includeBootstrap = c.req.query("bootstrap") === "1";

    const streamClientId = c.req.query("clientId") ?? null;

    return streamSSE(c, async (stream) => {
      const manager = getLocalTerminalManager();
      if (!manager.getSnapshot(terminalId)) {
        return;
      }
      let isConnected = true;
      const disconnectController = new AbortController();
      let unsubscribe: (() => void) | null = null;

      const cleanup = () => {
        if (!isConnected) {
          return;
        }
        isConnected = false;
        disconnectController.abort();
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (streamClientId) {
          manager.releaseWrite(terminalId, streamClientId);
        }
      };

      const writeTerminalEvent = async (event: TerminalStreamEvent) => {
        if (!isConnected) {
          return;
        }
        try {
          await stream.writeSSE({
            event: "terminal",
            data: JSON.stringify(event),
          });
        } catch {
          cleanup();
        }
      };

      const eventBatch = manager.getEventsSince(terminalId, fromSeq ?? 0);
      if (!eventBatch) {
        cleanup();
        return;
      }
      if (includeBootstrap) {
        const snapshot = manager.getSnapshot(terminalId);
        if (!snapshot) {
          cleanup();
          return;
        }
        await writeTerminalEvent({
          terminalId,
          seq: snapshot.seq,
          type: "bootstrap",
          snapshot,
          artifacts: await loadTerminalArtifacts(terminalId),
        });
        if (!isConnected) {
          return;
        }
      }
      if (eventBatch.requiresReset) {
        const snapshot = manager.getSnapshot(terminalId);
        if (!snapshot) {
          cleanup();
          return;
        }
        await writeTerminalEvent({
          terminalId,
          seq: snapshot.seq,
          type: "reset",
          output: snapshot.output,
          running: snapshot.running,
        });
        await writeTerminalEvent({
          terminalId,
          seq: snapshot.seq,
          type: "ownership",
          writeOwnerId: snapshot.writeOwnerId,
        });
      } else {
        for (const event of eventBatch.events) {
          await writeTerminalEvent(event);
          if (!isConnected) {
            return;
          }
        }
      }

      unsubscribe = manager.subscribeTerminal(terminalId, (event) => {
        void writeTerminalEvent(event);
      });

      stream.onAbort(cleanup);
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });

      try {
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
}
