import type {
  ConversationMessage,
  SessionsDeltaResponse,
  TerminalListResponse,
  TerminalEventsResponse,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@codex-deck/api";
import { decodeBase64 } from "@zuoyehaoduoa/wire";
import { parseConversationTextChunk } from "../../api/conversation-parser";
import type { RemoteClient } from "../remote-client";
import {
  createWakeablePollingSubscription,
  createPollingSubscription,
} from "./shared";
import type {
  ConversationStreamHandlers,
  ConversationStreamSubscriptionOptions,
  SessionsStreamHandlers,
  TerminalsStreamHandlers,
  TerminalStreamHandlers,
  TerminalStreamSubscriptionOptions,
  WorkflowDaemonStatusStreamHandlers,
  WorkflowDetailStreamHandlers,
  WorkflowsStreamHandlers,
  WebTransport,
} from "./types";

const REMOTE_CONVERSATION_CHUNK_MAX_BYTES = 512 * 1024;
const REMOTE_CONVERSATION_WINDOW_MAX_BYTES = 512 * 1024;
const REMOTE_CONVERSATION_BOOTSTRAP_WINDOW_MAX_BYTES = 128 * 1024;
// Keep remote polling requests short-lived so they do not block
// latency-sensitive requests (like conversation loads) through the
// relay path when only one RPC request can make progress at a time.
const REMOTE_SESSIONS_DELTA_WAIT_MS = 0;
const REMOTE_SESSIONS_POLL_INTERVAL_MS = 1_000;
const REMOTE_TERMINAL_EVENTS_WAIT_MS = 0;
const REMOTE_TERMINAL_EVENTS_POLL_INTERVAL_MS = 250;
const REMOTE_WORKFLOWS_POLL_INTERVAL_MS = 5_000;
const REMOTE_WORKFLOW_DETAIL_POLL_INTERVAL_MS = 3_000;
const REMOTE_WORKFLOW_DAEMON_STATUS_POLL_INTERVAL_MS = 5_000;

interface ConversationRawChunkResponse {
  chunkBase64: string;
  nextOffset: number;
  done: boolean;
}

interface ConversationRawWindowResponse {
  chunkBase64: string;
  startOffset: number;
  endOffset: number;
  fileSize: number;
  done: boolean;
}

function concatByteChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function getConversationSeenKey(message: ConversationMessage): string {
  const content =
    message.message && typeof message.message === "object"
      ? JSON.stringify(message.message.content ?? null)
      : "";
  return `${message.timestamp ?? ""}|${message.type}|${message.turnId ?? ""}|${content}`;
}

function collectChangedWorkflowKeys(
  previousWorkflows: WorkflowSummary[],
  nextWorkflows: WorkflowSummary[],
): string[] {
  const previousByKey = new Map(
    previousWorkflows.map((workflow) => [
      workflow.key,
      JSON.stringify(workflow),
    ]),
  );
  const nextByKey = new Map(
    nextWorkflows.map((workflow) => [workflow.key, JSON.stringify(workflow)]),
  );
  const changedKeys = new Set<string>();

  for (const [key, payload] of nextByKey) {
    if (previousByKey.get(key) !== payload) {
      changedKeys.add(key);
    }
  }
  for (const key of previousByKey.keys()) {
    if (!nextByKey.has(key)) {
      changedKeys.add(key);
    }
  }

  return Array.from(changedKeys);
}

async function getConversationRawChunk(
  remoteClient: RemoteClient,
  sessionId: string,
  offset: number,
): Promise<ConversationRawChunkResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    maxBytes: String(REMOTE_CONVERSATION_CHUNK_MAX_BYTES),
  });
  return remoteClient.requestJson<ConversationRawChunkResponse>(
    `/api/conversation/${encodeURIComponent(sessionId)}/raw-chunk?${params.toString()}`,
  );
}

async function getConversationRawWindow(
  remoteClient: RemoteClient,
  sessionId: string,
  beforeOffset?: number,
  maxBytes: number = REMOTE_CONVERSATION_WINDOW_MAX_BYTES,
): Promise<ConversationRawWindowResponse> {
  const params = new URLSearchParams({
    maxBytes: String(maxBytes),
  });
  if (typeof beforeOffset === "number" && Number.isFinite(beforeOffset)) {
    params.set("beforeOffset", String(Math.max(0, Math.floor(beforeOffset))));
  }
  return remoteClient.requestJson<ConversationRawWindowResponse>(
    `/api/conversation/${encodeURIComponent(sessionId)}/window?${params.toString()}`,
  );
}

async function readRemoteConversationBatch(
  remoteClient: RemoteClient,
  sessionId: string,
  offset: number,
  knownToolNames?: Map<string, string>,
): Promise<{
  messages: ConversationMessage[];
  nextOffset: number;
}> {
  let fetchOffset = offset;
  const aggregatedChunks: Uint8Array[] = [];

  while (true) {
    const previousFetchOffset = fetchOffset;
    const chunk = await getConversationRawChunk(
      remoteClient,
      sessionId,
      fetchOffset,
    );
    fetchOffset = chunk.nextOffset;

    if (chunk.chunkBase64) {
      aggregatedChunks.push(decodeBase64(chunk.chunkBase64));
    }

    if (chunk.done || fetchOffset <= previousFetchOffset) {
      break;
    }
  }

  const aggregatedText = new TextDecoder().decode(
    concatByteChunks(aggregatedChunks),
  );
  const result = parseConversationTextChunk(
    aggregatedText,
    offset,
    knownToolNames,
  );
  return {
    messages: result.messages,
    nextOffset: offset + result.consumedBytes,
  };
}

export async function readRemoteConversationSnapshot(
  remoteClient: RemoteClient,
  sessionId: string,
): Promise<ConversationMessage[]> {
  const toolNames = new Map<string, string>();
  let beforeOffset: number | undefined;
  const aggregated: ConversationMessage[] = [];

  while (true) {
    const window = await getConversationRawWindow(
      remoteClient,
      sessionId,
      beforeOffset,
    );
    const text = new TextDecoder().decode(decodeBase64(window.chunkBase64));
    const parsed = parseConversationTextChunk(
      text,
      window.startOffset,
      toolNames,
    );
    if (parsed.messages.length > 0) {
      aggregated.unshift(...parsed.messages);
    }
    if (window.startOffset <= 0 || window.done) {
      break;
    }
    beforeOffset = window.startOffset;
  }

  return aggregated;
}

export function createRemoteTransport(
  remoteClient: RemoteClient,
): WebTransport {
  const conversationWakeListeners = new Map<string, Set<() => void>>();
  const workflowWakeListeners = new Set<() => void>();
  const workflowDaemonStatusWakeListeners = new Set<() => void>();
  const workflowDetailWakeListeners = new Map<string, Set<() => void>>();

  const registerConversationWake = (
    sessionId: string,
    wake: () => void,
  ): (() => void) => {
    const listeners = conversationWakeListeners.get(sessionId) ?? new Set();
    listeners.add(wake);
    conversationWakeListeners.set(sessionId, listeners);

    return () => {
      const current = conversationWakeListeners.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(wake);
      if (current.size === 0) {
        conversationWakeListeners.delete(sessionId);
      }
    };
  };

  const registerWorkflowWake = (wake: () => void): (() => void) => {
    workflowWakeListeners.add(wake);
    return () => {
      workflowWakeListeners.delete(wake);
    };
  };

  const registerWorkflowDaemonStatusWake = (wake: () => void): (() => void) => {
    workflowDaemonStatusWakeListeners.add(wake);
    return () => {
      workflowDaemonStatusWakeListeners.delete(wake);
    };
  };

  const registerWorkflowDetailWake = (
    workflowKey: string,
    wake: () => void,
  ): (() => void) => {
    const listeners = workflowDetailWakeListeners.get(workflowKey) ?? new Set();
    listeners.add(wake);
    workflowDetailWakeListeners.set(workflowKey, listeners);

    return () => {
      const current = workflowDetailWakeListeners.get(workflowKey);
      if (!current) {
        return;
      }
      current.delete(wake);
      if (current.size === 0) {
        workflowDetailWakeListeners.delete(workflowKey);
      }
    };
  };

  return {
    requestJson<T>(url: string, init?: RequestInit): Promise<T> {
      return remoteClient.requestJson<T>(url, init);
    },

    notifyConversationMutation(sessionId: string): void {
      const listeners = conversationWakeListeners.get(sessionId);
      if (!listeners) {
        return;
      }
      for (const wake of listeners) {
        wake();
      }
    },

    notifyWorkflowMutation(workflowKey?: string | null): void {
      for (const wake of workflowWakeListeners) {
        wake();
      }
      for (const wake of workflowDaemonStatusWakeListeners) {
        wake();
      }
      if (workflowKey) {
        for (const wake of workflowDetailWakeListeners.get(workflowKey) ?? []) {
          wake();
        }
        return;
      }
      for (const listeners of workflowDetailWakeListeners.values()) {
        for (const wake of listeners) {
          wake();
        }
      }
    },

    subscribeSessionsStream(handlers: SessionsStreamHandlers): () => void {
      let version = 0;
      let initialized = false;

      return createPollingSubscription(async () => {
        try {
          const params = new URLSearchParams({
            sinceVersion: String(Math.max(0, Math.floor(version))),
            waitMs: String(REMOTE_SESSIONS_DELTA_WAIT_MS),
          });
          const delta = await remoteClient.requestJson<SessionsDeltaResponse>(
            `/api/sessions/delta?${params.toString()}`,
          );
          version = Math.max(version, delta.version);

          if (delta.isFullSnapshot || !initialized) {
            initialized = true;
            handlers.onSessions(delta.sessions);
            if (delta.skillsChangedSessionIds.length > 0) {
              for (const sessionId of delta.skillsChangedSessionIds) {
                handlers.onSkillsChanged?.({ sessionId });
              }
            }
            return;
          }

          if (delta.updates.length > 0) {
            handlers.onSessionsUpdate(delta.updates);
          }
          if (delta.removedSessionIds.length > 0) {
            handlers.onSessionsRemoved(delta.removedSessionIds);
          }
          if (delta.skillsChangedSessionIds.length > 0) {
            for (const sessionId of delta.skillsChangedSessionIds) {
              handlers.onSkillsChanged?.({ sessionId });
            }
          }
        } catch (error) {
          console.error(error);
          handlers.onError?.();
        }
      }, REMOTE_SESSIONS_POLL_INTERVAL_MS);
    },

    subscribeConversationStream(
      sessionId: string,
      handlers: ConversationStreamHandlers,
      options: ConversationStreamSubscriptionOptions = {},
    ): () => void {
      let seen = new Set<string>();
      const toolNames = new Map<string, string>();
      let offset =
        typeof options.initialOffset === "number" &&
        Number.isFinite(options.initialOffset) &&
        options.initialOffset > 0
          ? Math.floor(options.initialOffset)
          : 0;
      let initialized = offset > 0;
      let backfillBeforeOffset: number | null = null;

      const subscription = createWakeablePollingSubscription(async () => {
        try {
          if (!initialized) {
            const tailWindow = await getConversationRawWindow(
              remoteClient,
              sessionId,
              undefined,
              REMOTE_CONVERSATION_BOOTSTRAP_WINDOW_MAX_BYTES,
            );
            const tailText = new TextDecoder().decode(
              decodeBase64(tailWindow.chunkBase64),
            );
            const tailParsed = parseConversationTextChunk(
              tailText,
              tailWindow.startOffset,
              toolNames,
            );
            const batch = {
              messages: tailParsed.messages,
              nextOffset: tailWindow.endOffset,
            };
            offset = batch.nextOffset;
            backfillBeforeOffset =
              tailWindow.startOffset > 0 ? tailWindow.startOffset : null;

            for (const message of batch.messages) {
              seen.add(getConversationSeenKey(message));
            }

            handlers.onMessages(batch.messages, {
              messages: batch.messages,
              phase: "bootstrap",
              nextOffset: offset,
              done: true,
              insertion: "append",
            });

            initialized = true;
            handlers.onHeartbeat?.();
            return;
          }

          if (backfillBeforeOffset !== null && backfillBeforeOffset > 0) {
            for (let backfillPass = 0; backfillPass < 3; backfillPass += 1) {
              if (backfillBeforeOffset === null || backfillBeforeOffset <= 0) {
                break;
              }

              const window = await getConversationRawWindow(
                remoteClient,
                sessionId,
                backfillBeforeOffset,
              );
              backfillBeforeOffset =
                window.startOffset > 0 ? window.startOffset : null;

              const windowText = new TextDecoder().decode(
                decodeBase64(window.chunkBase64),
              );
              const parsed = parseConversationTextChunk(
                windowText,
                window.startOffset,
                toolNames,
              );
              const olderMessages = parsed.messages.filter(
                (message) => !seen.has(getConversationSeenKey(message)),
              );
              for (const message of parsed.messages) {
                seen.add(getConversationSeenKey(message));
              }

              if (olderMessages.length > 0) {
                handlers.onMessages(olderMessages, {
                  messages: olderMessages,
                  phase: "incremental",
                  nextOffset: offset,
                  done: true,
                  insertion: "prepend",
                });
              }
            }
          }

          const batch = await readRemoteConversationBatch(
            remoteClient,
            sessionId,
            offset,
            toolNames,
          );
          const newMessages = batch.messages.filter(
            (message) => !seen.has(getConversationSeenKey(message)),
          );
          for (const message of batch.messages) {
            seen.add(getConversationSeenKey(message));
          }
          offset = batch.nextOffset;
          if (newMessages.length > 0) {
            handlers.onMessages(newMessages, {
              messages: newMessages,
              phase: "incremental",
              nextOffset: offset,
              done: true,
              insertion: "append",
            });
          }

          handlers.onHeartbeat?.();
        } catch (error) {
          console.error(error);
          handlers.onError?.();
        }
      }, 1500);

      const unregisterWake = registerConversationWake(
        sessionId,
        subscription.wake,
      );

      return () => {
        unregisterWake();
        subscription.unsubscribe();
      };
    },

    subscribeTerminalsStream(handlers: TerminalsStreamHandlers): () => void {
      return createPollingSubscription(async () => {
        try {
          const response =
            await remoteClient.requestJson<TerminalListResponse>(
              "/api/terminals",
            );
          handlers.onTerminals(response.terminals);
        } catch (error) {
          console.error(error);
          handlers.onError?.();
        }
      }, 500);
    },

    subscribeWorkflowsStream(handlers: WorkflowsStreamHandlers): () => void {
      let workflows: WorkflowSummary[] = [];
      let previousPayload = "";
      const subscription = createWakeablePollingSubscription(async () => {
        try {
          const response = await remoteClient.requestJson<{
            workflows: WorkflowSummary[];
          }>("/api/workflows");
          const nextWorkflows = Array.isArray(response.workflows)
            ? response.workflows
            : [];
          const nextPayload = JSON.stringify(nextWorkflows);
          if (nextPayload === previousPayload) {
            return;
          }
          const changedWorkflowKeys = collectChangedWorkflowKeys(
            workflows,
            nextWorkflows,
          );
          previousPayload = nextPayload;
          workflows = nextWorkflows;
          handlers.onWorkflows(workflows);
          for (const workflowKey of changedWorkflowKeys) {
            for (const wake of workflowDetailWakeListeners.get(workflowKey) ??
              []) {
              wake();
            }
          }
        } catch (error) {
          console.error(error);
          handlers.onError?.();
        }
      }, REMOTE_WORKFLOWS_POLL_INTERVAL_MS);
      const unregisterWake = registerWorkflowWake(subscription.wake);
      return () => {
        unregisterWake();
        subscription.unsubscribe();
      };
    },

    subscribeWorkflowDaemonStatusStream(
      handlers: WorkflowDaemonStatusStreamHandlers,
    ): () => void {
      let previousPayload = "";
      const subscription = createWakeablePollingSubscription(async () => {
        try {
          const response =
            await remoteClient.requestJson<WorkflowDaemonStatusResponse>(
              "/api/workflows/daemon-status",
            );
          const nextPayload = JSON.stringify(response);
          if (nextPayload === previousPayload) {
            return;
          }
          previousPayload = nextPayload;
          handlers.onDaemonStatus(response);
        } catch (error) {
          console.error(error);
          handlers.onError?.();
        }
      }, REMOTE_WORKFLOW_DAEMON_STATUS_POLL_INTERVAL_MS);
      const unregisterWake = registerWorkflowDaemonStatusWake(
        subscription.wake,
      );
      return () => {
        unregisterWake();
        subscription.unsubscribe();
      };
    },

    subscribeWorkflowDetailStream(
      workflowKey: string,
      handlers: WorkflowDetailStreamHandlers,
    ): () => void {
      let previousPayload = "";
      const subscription = createWakeablePollingSubscription(async () => {
        try {
          const response =
            await remoteClient.requestJson<WorkflowDetailResponse>(
              `/api/workflows/${encodeURIComponent(workflowKey)}`,
            );
          const nextPayload = JSON.stringify(response);
          if (nextPayload === previousPayload) {
            return;
          }
          previousPayload = nextPayload;
          handlers.onWorkflowDetail(response);
        } catch (error) {
          console.error(error);
          handlers.onError?.();
        }
      }, REMOTE_WORKFLOW_DETAIL_POLL_INTERVAL_MS);
      const unregisterWake = registerWorkflowDetailWake(
        workflowKey,
        subscription.wake,
      );
      return () => {
        unregisterWake();
        subscription.unsubscribe();
      };
    },

    subscribeTerminalStream(
      handlers: TerminalStreamHandlers,
      options: TerminalStreamSubscriptionOptions,
    ): () => void {
      let fromSeq = 0;
      let shouldBootstrap = options.bootstrap === true;

      return createPollingSubscription(async () => {
        try {
          const params = new URLSearchParams({
            fromSeq: String(fromSeq),
            waitMs: String(REMOTE_TERMINAL_EVENTS_WAIT_MS),
          });
          if (shouldBootstrap) {
            params.set("bootstrap", "1");
          }
          const batch = await remoteClient.requestJson<TerminalEventsResponse>(
            `/api/terminals/${encodeURIComponent(options.terminalId)}/events?${params.toString()}`,
          );

          if (shouldBootstrap && batch.bootstrap) {
            handlers.onEvent({
              terminalId: batch.bootstrap.snapshot.terminalId,
              seq: batch.bootstrap.snapshot.seq,
              type: "bootstrap",
              snapshot: batch.bootstrap.snapshot,
              artifacts: batch.bootstrap.artifacts,
            });
            fromSeq = Math.max(fromSeq, batch.bootstrap.snapshot.seq);
            shouldBootstrap = false;
          }

          if (batch.requiresReset && batch.snapshot) {
            handlers.onEvent({
              terminalId: batch.snapshot.terminalId,
              seq: batch.snapshot.seq,
              type: "reset",
              output: batch.snapshot.output,
              running: batch.snapshot.running,
            });
            handlers.onEvent({
              terminalId: batch.snapshot.terminalId,
              seq: batch.snapshot.seq,
              type: "ownership",
              writeOwnerId: batch.snapshot.writeOwnerId,
            });
            fromSeq = batch.snapshot.seq;
          }

          for (const event of batch.events) {
            if (!event || typeof event !== "object" || event.seq <= fromSeq) {
              continue;
            }
            handlers.onEvent(event);
            fromSeq = event.seq;
          }
        } catch (error) {
          console.error(error);
          handlers.onError?.();
        }
      }, REMOTE_TERMINAL_EVENTS_POLL_INTERVAL_MS);
    },
  };
}
