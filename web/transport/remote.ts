import type {
  CodexAppServerEvent,
  CodexDeckUpdateOutputResponse,
  ConversationMessage,
  ConversationMessageWindow,
  StreamResult,
  SessionsDeltaResponse,
  TerminalListResponse,
  TerminalEventsResponse,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowSummary,
  DiffGuideSummary,
} from "@codex-deck/api";
import type { RemoteClient } from "../remote-client";
import type { ConversationHoverSettings } from "../../api/conversation-hover-settings";
import {
  createWakeablePollingSubscription,
  createPollingSubscription,
} from "./shared";
import type {
  CodexDeckUpdateOutputStreamHandlers,
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

function getCodexAppServerEventKey(event: CodexAppServerEvent): string {
  switch (event.type) {
    case "native_state_changed":
      return event.revision;
    case "background_terminals_changed":
      return [event.type, event.threadId, event.changeId].join("|");
    case "operational_notification":
      return event.notification.id;
    case "hook_run":
      return JSON.stringify(event);
    case "user_input_requests_changed":
    case "elicitation_requests_changed":
      return [event.type, event.threadId, event.requestId, event.pending].join(
        "|",
      );
    case "image_generation_updated":
    case "item_completed":
      return [event.type, event.threadId, event.turnId, event.itemId].join("|");
    case "error":
      return [
        event.type,
        event.threadId,
        event.turnId,
        event.willRetry,
        event.error?.message ?? "",
        event.error?.additionalDetails ?? "",
      ].join("|");
    case "assistant_delta":
    case "plan_delta":
      return [
        event.type,
        event.threadId,
        event.turnId,
        event.itemId,
        event.delta,
      ].join("|");
    case "reasoning_summary_delta":
      return [
        event.type,
        event.threadId,
        event.turnId,
        event.itemId,
        event.summaryIndex,
        event.delta,
      ].join("|");
    case "reasoning_text_delta":
      return [
        event.type,
        event.threadId,
        event.turnId,
        event.itemId,
        event.contentIndex,
        event.delta,
      ].join("|");
    case "thread_status":
      return [
        event.type,
        event.threadId,
        event.status,
        event.turnId ?? "",
      ].join("|");
    case "subagent_activity":
      return [
        event.type,
        event.threadId,
        event.turnId ?? "",
        event.itemId,
        event.agentThreadId,
        event.agentPath,
        event.kind,
      ].join("|");
    case "collab_agent_tool_call":
      return [
        event.type,
        event.threadId,
        event.turnId ?? "",
        event.itemId,
        event.tool,
        event.status,
        event.senderThreadId,
        event.receiverThreadIds.join(","),
        event.prompt ?? "",
        event.model ?? "",
        event.reasoningEffort ?? "",
        JSON.stringify(event.agentsStates),
      ].join("|");
  }
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

export async function readRemoteConversationSnapshot(
  remoteClient: RemoteClient,
  sessionId: string,
): Promise<ConversationMessage[]> {
  const messages = new Map<number, ConversationMessage>();
  let beforeSequence: number | undefined;
  let fileId: string | undefined;
  do {
    const batch = await remoteClient.requestJson<ConversationMessageWindow>(
      `/api/conversation/${encodeURIComponent(sessionId)}/messages${beforeSequence ? `?beforeSequence=${beforeSequence}` : ""}`,
    );
    if (fileId && batch.fileId !== fileId) {
      messages.clear();
      beforeSequence = undefined;
      fileId = undefined;
      continue;
    }
    fileId = batch.fileId;
    for (const message of batch.messages)
      messages.set(message.sequence!, message);
    if (beforeSequence && batch.historyStartSequence >= beforeSequence)
      throw new Error("Conversation history window did not advance");
    beforeSequence = batch.historyStartSequence;
  } while (beforeSequence);
  return [...messages.values()].sort((a, b) => a.sequence! - b.sequence!);
}

export function createRemoteTransport(
  remoteClient: RemoteClient,
): WebTransport {
  const conversationWakeListeners = new Map<string, Set<() => void>>();
  const conversationAppServerSubscribers = new Map<
    string,
    Set<(event: CodexAppServerEvent) => void>
  >();
  const workflowWakeListeners = new Set<() => void>();
  const workflowDaemonStatusWakeListeners = new Set<() => void>();
  const workflowDetailWakeListeners = new Map<string, Set<() => void>>();
  const seenCodexAppServerEventKeys = new Set<string>();
  const seenCodexAppServerEventOrder: string[] = [];

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

  const registerConversationAppServerSubscriber = (
    sessionId: string,
    subscriber: (event: CodexAppServerEvent) => void,
  ): (() => void) => {
    const subscribers =
      conversationAppServerSubscribers.get(sessionId) ??
      new Set<(event: CodexAppServerEvent) => void>();
    subscribers.add(subscriber);
    conversationAppServerSubscribers.set(sessionId, subscribers);

    return () => {
      const current = conversationAppServerSubscribers.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(subscriber);
      if (current.size === 0) {
        conversationAppServerSubscribers.delete(sessionId);
      }
    };
  };

  const dispatchConversationAppServerEvent = (
    event: CodexAppServerEvent,
    handler?: (event: CodexAppServerEvent) => void,
  ) => {
    const eventKey = getCodexAppServerEventKey(event);
    if (seenCodexAppServerEventKeys.has(eventKey)) {
      return;
    }
    seenCodexAppServerEventKeys.add(eventKey);
    seenCodexAppServerEventOrder.push(eventKey);
    if (seenCodexAppServerEventOrder.length > 4096) {
      const oldestKey = seenCodexAppServerEventOrder.shift();
      if (oldestKey) {
        seenCodexAppServerEventKeys.delete(oldestKey);
      }
    }

    handler?.(event);
    if (!event.threadId) return;
    for (const subscriber of conversationAppServerSubscribers.get(
      event.threadId,
    ) ?? []) {
      subscriber(event);
    }
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
    subscribeConversationHoverSettings: (handlers) => {
      let previous = "";
      return createPollingSubscription(async () => {
        try {
          const settings =
            await remoteClient.requestJson<ConversationHoverSettings>(
              "/api/codex-deck/hover-settings",
            );
          const payload = JSON.stringify(settings);
          if (payload !== previous) {
            previous = payload;
            handlers.onSettings(settings);
          }
        } catch {
          handlers.onError?.();
        }
      }, 5_000);
    },
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
      let previousDiffGuides = "";

      return createPollingSubscription(async () => {
        try {
          const params = new URLSearchParams({
            sinceVersion: String(Math.max(0, Math.floor(version))),
            waitMs: String(REMOTE_SESSIONS_DELTA_WAIT_MS),
          });
          const [delta, guides] = await Promise.all([
            remoteClient.requestJson<SessionsDeltaResponse>(
              `/api/sessions/delta?${params.toString()}`,
            ),
            handlers.onDiffGuides
              ? remoteClient
                  .requestJson<DiffGuideSummary[]>("/api/diff-guides")
                  .catch(() => null)
              : Promise.resolve(null),
          ]);
          const diffPayload = JSON.stringify(guides);
          if (guides && diffPayload !== previousDiffGuides) {
            previousDiffGuides = diffPayload;
            handlers.onDiffGuides?.(guides);
          }
          version = Math.max(version, delta.version);

          if (delta.isFullSnapshot || !initialized) {
            initialized = true;
            handlers.onSessions(delta.sessions);
            if (delta.skillsChangedSessionIds.length > 0) {
              for (const sessionId of delta.skillsChangedSessionIds) {
                handlers.onSkillsChanged?.({ sessionId });
              }
            }
          } else {
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
          }

          for (const event of delta.codexAppServerEvents ?? []) {
            dispatchConversationAppServerEvent(
              event,
              handlers.onCodexAppServerEvent,
            );
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
      const path = `/api/conversation/${encodeURIComponent(sessionId)}`;
      let offset = options.initialOffset ?? 0;
      let initialized = offset > 0;
      let beforeSequence = options.initialHistoryStartSequence ?? 0;
      let fileId = options.initialFileId;
      let cancelled = false;
      const unregisterAppServerSubscriber = options.onCodexAppServerEvent
        ? registerConversationAppServerSubscriber(
            sessionId,
            options.onCodexAppServerEvent,
          )
        : null;
      const acceptIdentity = (batch: StreamResult) => {
        if (fileId && batch.fileId && fileId !== batch.fileId) {
          offset = 0;
          initialized = false;
          beforeSequence = 0;
          fileId = batch.fileId;
          handlers.onReset?.();
          return false;
        }
        fileId = batch.fileId ?? fileId;
        return true;
      };
      const subscription = createWakeablePollingSubscription(async () => {
        try {
          if (!initialized) {
            const batch =
              await remoteClient.requestJson<ConversationMessageWindow>(
                `${path}/messages`,
              );
            if (cancelled) return;
            if (!acceptIdentity(batch)) return;
            offset = batch.nextOffset;
            beforeSequence = batch.historyStartSequence;
            initialized = true;
            handlers.onMessages(batch.messages, {
              ...batch,
              phase: "bootstrap",
              insertion: "append",
            });
            handlers.onHeartbeat?.();
            return;
          }
          if (beforeSequence > 0) {
            const batch =
              await remoteClient.requestJson<ConversationMessageWindow>(
                `${path}/messages?beforeSequence=${beforeSequence}`,
              );
            if (cancelled) return;
            if (!acceptIdentity(batch)) return;
            if (batch.historyStartSequence >= beforeSequence)
              throw new Error("Conversation history window did not advance");
            beforeSequence = batch.historyStartSequence;
            handlers.onMessages(batch.messages, {
              ...batch,
              nextOffset: offset,
              phase: "incremental",
              insertion: "prepend",
            });
          }
          const messages: ConversationMessage[] = [];
          let latest: StreamResult;
          do {
            const previousOffset = offset;
            latest = await remoteClient.requestJson<StreamResult>(
              `${path}/updates?offset=${offset}`,
            );
            if (cancelled) return;
            if (!acceptIdentity(latest)) return;
            offset = latest.nextOffset;
            messages.push(...latest.messages);
            if (latest.done || offset <= previousOffset) break;
          } while (!cancelled);
          if (messages.length > 0)
            handlers.onMessages(messages, {
              ...latest!,
              messages,
              nextOffset: offset,
              historyStartSequence: beforeSequence,
              phase: "incremental",
              insertion: "append",
            });
          handlers.onHeartbeat?.();
        } catch (error) {
          if (cancelled) return;
          console.error(error);
          handlers.onError?.();
        }
      }, 1500);

      const unregisterWake = registerConversationWake(
        sessionId,
        subscription.wake,
      );

      return () => {
        cancelled = true;
        unregisterAppServerSubscriber?.();
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

    subscribeCodexDeckUpdateOutput(
      handlers: CodexDeckUpdateOutputStreamHandlers,
    ): () => void {
      let cancelled = false;
      let previousPayload = "";
      const unsubscribe = createPollingSubscription(async () => {
        try {
          const response =
            await remoteClient.requestJson<CodexDeckUpdateOutputResponse>(
              "/api/codex-deck/update/output",
            );
          const payload = JSON.stringify(response);
          if (!cancelled && payload !== previousPayload) {
            previousPayload = payload;
            handlers.onOutput(response);
          }
        } catch {
          if (!cancelled) {
            handlers.onError?.();
          }
        }
      }, 1_000);
      return () => {
        cancelled = true;
        unsubscribe();
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
