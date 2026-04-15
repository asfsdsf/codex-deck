import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getLocalTerminalManager } from "../local-terminal";
import {
  clearTerminalBinding,
  getTerminalBinding,
  getTerminalBindingsByTerminalIds,
  getTerminalSessionRoles,
  onTerminalBindingChange,
  setTerminalBinding,
  TerminalBindingConflictError,
} from "../terminal-bindings";
import type {
  CreateTerminalRequest,
  TerminalBindSessionRequest,
  TerminalBindingResponse,
  TerminalClaimWriteRequest,
  TerminalCommandResponse,
  TerminalExecuteCommandRequest,
  TerminalExecuteCommandResponse,
  TerminalEventsResponse,
  TerminalInputRequest,
  TerminalListResponse,
  TerminalReleaseWriteRequest,
  TerminalResizeRequest,
  TerminalSessionRolesRequest,
  TerminalSessionRolesResponse,
  TerminalSnapshotResponse,
  TerminalStreamEvent,
  TerminalSummary,
} from "../storage";
import {
  MAX_LONG_POLL_WAIT_MS,
  parseNonNegativeInteger,
  responseStatusForError,
  toErrorMessage,
} from "./utils";

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

export function registerTerminalRoutes(app: Hono): void {
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
      let unsubscribeTerminals: (() => void) | null = null;
      let unsubscribeBindings: (() => void) | null = null;

      const cleanup = () => {
        isConnected = false;
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
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
    });
  });

  app.get("/api/terminals/:terminalId", async (c) => {
    const manager = getLocalTerminalManager();
    const snapshot = manager.getSnapshot(c.req.param("terminalId"));
    if (!snapshot) {
      return c.json({ error: "terminal not found" }, 404);
    }
    return c.json(snapshot satisfies TerminalSnapshotResponse);
  });

  app.get("/api/terminals/:terminalId/binding", async (c) => {
    try {
      const terminalId = c.req.param("terminalId")?.trim();
      if (!terminalId) {
        return c.json({ error: "terminal id is required" }, 400);
      }

      const manager = getLocalTerminalManager();
      if (!manager.getSnapshot(terminalId)) {
        return c.json({ error: "terminal not found" }, 404);
      }

      return c.json(
        (await getTerminalBinding(
          terminalId,
        )) satisfies TerminalBindingResponse,
      );
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
      const currentOwner = manager.getWriteOwnerId(terminalId);
      if (currentOwner && clientId !== currentOwner) {
        return c.json({ error: "another client owns terminal write" }, 403);
      }

      manager.writeInput(terminalId, body.input);
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

  app.post("/api/terminals/:terminalId/execute", async (c) => {
    try {
      const terminalId = c.req.param("terminalId");
      const body = (await c.req
        .json()
        .catch(() => ({}))) as Partial<TerminalExecuteCommandRequest>;
      if (typeof body.command !== "string" || !body.command.trim()) {
        return c.json({ error: "command must be a non-empty string" }, 400);
      }
      if (
        body.cwd !== undefined &&
        body.cwd !== null &&
        typeof body.cwd !== "string"
      ) {
        return c.json({ error: "cwd must be a string or null" }, 400);
      }
      if (
        body.displayCommand !== undefined &&
        body.displayCommand !== null &&
        typeof body.displayCommand !== "string"
      ) {
        return c.json(
          { error: "displayCommand must be a string or null" },
          400,
        );
      }
      if (
        body.timeoutMs !== undefined &&
        (!Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0)
      ) {
        return c.json({ error: "timeoutMs must be a positive number" }, 400);
      }

      const clientId = c.req.query("clientId");
      const manager = getLocalTerminalManager();
      const snapshot = manager.getSnapshot(terminalId);
      if (!snapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      const currentOwner = manager.getWriteOwnerId(terminalId);
      if (currentOwner && clientId !== currentOwner) {
        return c.json({ error: "another client owns terminal write" }, 403);
      }

      const result = await manager.executeCommand(terminalId, {
        command: body.command,
        cwd: body.cwd,
        timeoutMs:
          typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
        displayCommand: body.displayCommand,
      });
      if (!result) {
        return c.json({ error: "terminal not found" }, 404);
      }
      const nextSnapshot = manager.getSnapshot(terminalId);
      if (!nextSnapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      return c.json({
        ...toTerminalCommandResponse(nextSnapshot.terminalId, nextSnapshot),
        startSeq: result.startSeq,
        endSeq: result.endSeq,
        exitCode: result.exitCode,
        cwdAfter: result.cwdAfter,
        rawOutput: result.rawOutput,
        timedOut: result.timedOut,
      } satisfies TerminalExecuteCommandResponse);
    } catch (error) {
      const message = toErrorMessage(error);
      const lowerMessage = message.toLowerCase();
      const status = lowerMessage.includes("not running")
        ? 409
        : lowerMessage.includes("active command")
          ? 409
          : responseStatusForError(error);
      return c.json({ error: message }, status);
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

  app.post("/api/terminals/:terminalId/interrupt", async (c) => {
    try {
      const terminalId = c.req.param("terminalId");
      const clientId = c.req.query("clientId");
      const manager = getLocalTerminalManager();
      const snapshot = manager.getSnapshot(terminalId);
      if (!snapshot) {
        return c.json({ error: "terminal not found" }, 404);
      }
      const currentOwner = manager.getWriteOwnerId(terminalId);
      if (currentOwner && clientId !== currentOwner) {
        return c.json({ error: "another client owns terminal write" }, 403);
      }

      manager.interrupt(terminalId);
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

    const streamClientId = c.req.query("clientId") ?? null;

    return streamSSE(c, async (stream) => {
      const manager = getLocalTerminalManager();
      if (!manager.getSnapshot(terminalId)) {
        return;
      }
      let isConnected = true;
      let unsubscribe: (() => void) | null = null;

      const cleanup = () => {
        isConnected = false;
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

      c.req.raw.signal.addEventListener("abort", cleanup);

      try {
        while (isConnected) {
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ timestamp: Date.now() }),
          });
          await stream.sleep(30000);
        }
      } catch {
        // Connection closed.
      } finally {
        cleanup();
      }
    });
  });
}
