import type {
  ConversationMessage,
  TerminalSummary,
  TerminalStreamEvent,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@codex-deck/api";
import {
  createReconnectingEventSource,
  createWakeablePollingSubscription,
  requestLocalJson,
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

const WORKFLOW_DETAIL_POLL_INTERVAL_MS = 3_000;
const WORKFLOW_DAEMON_STATUS_POLL_INTERVAL_MS = 5_000;

interface ConversationStreamPayload {
  messages: unknown;
  nextOffset?: number;
  done?: boolean;
}

function registerWakeListener(
  listeners: Set<() => void>,
  wake: () => void,
): () => void {
  listeners.add(wake);
  return () => {
    listeners.delete(wake);
  };
}

function registerKeyedWakeListener(
  listenersByKey: Map<string, Set<() => void>>,
  key: string,
  wake: () => void,
): () => void {
  const listeners = listenersByKey.get(key) ?? new Set<() => void>();
  listeners.add(wake);
  listenersByKey.set(key, listeners);
  return () => {
    const current = listenersByKey.get(key);
    if (!current) {
      return;
    }
    current.delete(wake);
    if (current.size === 0) {
      listenersByKey.delete(key);
    }
  };
}

function parseTerminalEvent(data: string): TerminalStreamEvent | null {
  try {
    const parsed = JSON.parse(data) as TerminalStreamEvent;
    if (!parsed || typeof parsed !== "object" || !Number.isFinite(parsed.seq)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function sortWorkflows(workflows: WorkflowSummary[]): WorkflowSummary[] {
  return [...workflows].sort((left, right) => {
    const runningDelta =
      Number(right.schedulerRunning) - Number(left.schedulerRunning);
    if (runningDelta !== 0) {
      return runningDelta;
    }
    const leftUpdated = Date.parse(left.updatedAt || "") || 0;
    const rightUpdated = Date.parse(right.updatedAt || "") || 0;
    return rightUpdated - leftUpdated;
  });
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

export function createLocalTransport(): WebTransport {
  const workflowWakeListeners = new Set<() => void>();
  const workflowDaemonStatusWakeListeners = new Set<() => void>();
  const workflowDetailWakeListeners = new Map<string, Set<() => void>>();
  const sessionsStreamSubscribers = new Set<SessionsStreamHandlers>();
  const terminalsStreamSubscribers = new Set<TerminalsStreamHandlers>();
  const workflowsStreamSubscribers = new Set<{
    onWorkflows: (workflows: WorkflowSummary[]) => void;
    onWorkflowsUpdate: (workflows: WorkflowSummary[]) => void;
    onWorkflowsRemoved: (workflowKeys: string[]) => void;
    onError?: () => void;
  }>();
  let unsubscribeSharedRealtimeStream: (() => void) | null = null;

  const stopSharedRealtimeStreamIfIdle = () => {
    if (
      !unsubscribeSharedRealtimeStream ||
      sessionsStreamSubscribers.size > 0 ||
      terminalsStreamSubscribers.size > 0 ||
      workflowsStreamSubscribers.size > 0
    ) {
      return;
    }

    unsubscribeSharedRealtimeStream();
    unsubscribeSharedRealtimeStream = null;
  };

  const ensureSharedRealtimeStream = () => {
    if (unsubscribeSharedRealtimeStream) {
      return;
    }

    // Keep a single local EventSource for global realtime state so two visible
    // pages do not exhaust the browser's per-origin connection budget.
    unsubscribeSharedRealtimeStream = createReconnectingEventSource({
      createUrl: () => "/api/sessions/stream",
      configure: (eventSource) => {
        eventSource.addEventListener("sessions", (event) => {
          const sessions = JSON.parse(event.data);
          for (const subscriber of sessionsStreamSubscribers) {
            subscriber.onSessions(sessions);
          }
        });
        eventSource.addEventListener("sessionsUpdate", (event) => {
          const sessions = JSON.parse(event.data);
          for (const subscriber of sessionsStreamSubscribers) {
            subscriber.onSessionsUpdate(sessions);
          }
        });
        eventSource.addEventListener("sessionsRemoved", (event) => {
          const payload = JSON.parse(event.data) as { sessionIds?: string[] };
          const sessionIds = Array.isArray(payload.sessionIds)
            ? payload.sessionIds
            : [];
          for (const subscriber of sessionsStreamSubscribers) {
            subscriber.onSessionsRemoved(sessionIds);
          }
        });
        eventSource.addEventListener("skillsChanged", (event) => {
          const payload = JSON.parse(event.data) as { sessionId?: unknown };
          if (typeof payload.sessionId !== "string") {
            return;
          }
          for (const subscriber of sessionsStreamSubscribers) {
            subscriber.onSkillsChanged?.({ sessionId: payload.sessionId });
          }
        });
        eventSource.addEventListener("terminals", (event) => {
          const terminals = JSON.parse(event.data) as TerminalSummary[];
          for (const subscriber of terminalsStreamSubscribers) {
            subscriber.onTerminals(terminals);
          }
        });
        eventSource.addEventListener("workflows", (event) => {
          const workflows = JSON.parse(event.data) as WorkflowSummary[];
          for (const subscriber of workflowsStreamSubscribers) {
            subscriber.onWorkflows(workflows);
          }
        });
        eventSource.addEventListener("workflowsUpdate", (event) => {
          const workflows = JSON.parse(event.data) as WorkflowSummary[];
          for (const subscriber of workflowsStreamSubscribers) {
            subscriber.onWorkflowsUpdate(workflows);
          }
        });
        eventSource.addEventListener("workflowsRemoved", (event) => {
          const payload = JSON.parse(event.data) as {
            workflowKeys?: string[];
          };
          const workflowKeys = Array.isArray(payload.workflowKeys)
            ? payload.workflowKeys
            : [];
          for (const subscriber of workflowsStreamSubscribers) {
            subscriber.onWorkflowsRemoved(workflowKeys);
          }
        });
      },
      onDisconnect: () => {
        for (const subscriber of sessionsStreamSubscribers) {
          subscriber.onError?.();
        }
        for (const subscriber of terminalsStreamSubscribers) {
          subscriber.onError?.();
        }
        for (const subscriber of workflowsStreamSubscribers) {
          subscriber.onError?.();
        }
      },
    });
  };

  return {
    requestJson: requestLocalJson,
    notifyConversationMutation: () => {},
    notifyWorkflowMutation: (workflowKey?: string | null) => {
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
      sessionsStreamSubscribers.add(handlers);
      ensureSharedRealtimeStream();

      return () => {
        sessionsStreamSubscribers.delete(handlers);
        stopSharedRealtimeStreamIfIdle();
      };
    },

    subscribeTerminalsStream(handlers: TerminalsStreamHandlers): () => void {
      terminalsStreamSubscribers.add(handlers);
      ensureSharedRealtimeStream();

      return () => {
        terminalsStreamSubscribers.delete(handlers);
        stopSharedRealtimeStreamIfIdle();
      };
    },

    subscribeWorkflowsStream(handlers: WorkflowsStreamHandlers): () => void {
      let workflows: WorkflowSummary[] = [];
      let previousPayload = "";

      const wakeWorkflowDetails = (workflowKeys: string[]) => {
        for (const workflowKey of workflowKeys) {
          for (const wake of workflowDetailWakeListeners.get(workflowKey) ??
            []) {
            wake();
          }
        }
      };

      const publishWorkflows = (nextWorkflows: WorkflowSummary[]) => {
        const sortedWorkflows = sortWorkflows(nextWorkflows);
        const nextPayload = JSON.stringify(sortedWorkflows);
        if (nextPayload === previousPayload) {
          return;
        }
        const changedWorkflowKeys = collectChangedWorkflowKeys(
          workflows,
          sortedWorkflows,
        );
        previousPayload = nextPayload;
        workflows = sortedWorkflows;
        handlers.onWorkflows(workflows);
        wakeWorkflowDetails(changedWorkflowKeys);
      };

      const applyWorkflowUpdates = (updates: WorkflowSummary[]) => {
        const workflowMap = new Map(
          workflows.map((workflow) => [workflow.key, workflow]),
        );
        for (const update of updates) {
          workflowMap.set(update.key, update);
        }
        publishWorkflows(Array.from(workflowMap.values()));
      };

      const applyWorkflowRemovals = (workflowKeys: string[]) => {
        if (workflowKeys.length === 0) {
          return;
        }
        const removedKeys = new Set(workflowKeys);
        publishWorkflows(
          workflows.filter((workflow) => !removedKeys.has(workflow.key)),
        );
      };

      const refreshWorkflows = async () => {
        try {
          const response = await requestLocalJson<{
            workflows: WorkflowSummary[];
          }>("/api/workflows");
          const nextWorkflows = Array.isArray(response.workflows)
            ? response.workflows
            : [];
          publishWorkflows(nextWorkflows);
        } catch (error) {
          console.error(error);
          handlers.onError?.();
        }
      };

      const unregisterWake = registerWakeListener(workflowWakeListeners, () => {
        void refreshWorkflows();
      });
      const workflowSubscriber = {
        onWorkflows: publishWorkflows,
        onWorkflowsUpdate: applyWorkflowUpdates,
        onWorkflowsRemoved: applyWorkflowRemovals,
        onError: handlers.onError,
      };
      workflowsStreamSubscribers.add(workflowSubscriber);
      ensureSharedRealtimeStream();

      return () => {
        unregisterWake();
        workflowsStreamSubscribers.delete(workflowSubscriber);
        stopSharedRealtimeStreamIfIdle();
      };
    },

    subscribeWorkflowDaemonStatusStream(
      handlers: WorkflowDaemonStatusStreamHandlers,
    ): () => void {
      let previousPayload = "";
      const subscription = createWakeablePollingSubscription(async () => {
        try {
          const response = await requestLocalJson<WorkflowDaemonStatusResponse>(
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
      }, WORKFLOW_DAEMON_STATUS_POLL_INTERVAL_MS);
      const unregisterWake = registerWakeListener(
        workflowDaemonStatusWakeListeners,
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
          const response = await requestLocalJson<WorkflowDetailResponse>(
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
      }, WORKFLOW_DETAIL_POLL_INTERVAL_MS);
      const unregisterWake = registerKeyedWakeListener(
        workflowDetailWakeListeners,
        workflowKey,
        subscription.wake,
      );
      return () => {
        unregisterWake();
        subscription.unsubscribe();
      };
    },

    subscribeConversationStream(
      sessionId: string,
      handlers: ConversationStreamHandlers,
      options: ConversationStreamSubscriptionOptions = {},
    ): () => void {
      let offset =
        typeof options.initialOffset === "number" &&
        Number.isFinite(options.initialOffset) &&
        options.initialOffset > 0
          ? Math.floor(options.initialOffset)
          : 0;
      let bootstrapComplete = offset > 0;

      return createReconnectingEventSource({
        createUrl: () =>
          `/api/conversation/${encodeURIComponent(sessionId)}/stream?offset=${offset}`,
        configure: (eventSource) => {
          eventSource.addEventListener("messages", (event) => {
            const payload = JSON.parse(event.data) as
              | ConversationStreamPayload
              | unknown[];
            const messages = (
              Array.isArray(payload)
                ? payload
                : Array.isArray(payload.messages)
                  ? payload.messages
                  : []
            ) as ConversationMessage[];
            if (
              !Array.isArray(payload) &&
              Number.isFinite(payload.nextOffset) &&
              typeof payload.nextOffset === "number"
            ) {
              offset = Math.max(offset, Math.floor(payload.nextOffset));
            }

            const done =
              Array.isArray(payload) || typeof payload.done !== "boolean"
                ? true
                : payload.done;
            const phase = bootstrapComplete ? "incremental" : "bootstrap";
            if (done) {
              bootstrapComplete = true;
            }
            handlers.onMessages(messages, {
              messages,
              phase,
              nextOffset: offset,
              done,
              insertion: "append",
            });
          });
          eventSource.addEventListener("heartbeat", () => {
            handlers.onHeartbeat?.();
          });
        },
        onDisconnect: handlers.onError,
      });
    },

    subscribeTerminalStream(
      handlers: TerminalStreamHandlers,
      options: TerminalStreamSubscriptionOptions,
    ): () => void {
      let fromSeq =
        typeof options.fromSeq === "number" &&
        Number.isFinite(options.fromSeq) &&
        options.fromSeq >= 0
          ? Math.floor(options.fromSeq)
          : 0;
      const conversationSessionId =
        options.conversationSessionId?.trim() || null;
      let conversationOffset =
        typeof options.conversationInitialOffset === "number" &&
        Number.isFinite(options.conversationInitialOffset) &&
        options.conversationInitialOffset > 0
          ? Math.floor(options.conversationInitialOffset)
          : 0;
      let conversationBootstrapComplete = conversationOffset > 0;

      return createReconnectingEventSource({
        createUrl: () => {
          const params = new URLSearchParams({
            fromSeq: String(fromSeq),
          });
          if (options.clientId?.trim()) {
            params.set("clientId", options.clientId.trim());
          }
          if (conversationSessionId) {
            params.set("conversationSessionId", conversationSessionId);
            params.set("conversationOffset", String(conversationOffset));
          }
          return `/api/terminals/${encodeURIComponent(options.terminalId)}/stream?${params.toString()}`;
        },
        configure: (eventSource) => {
          eventSource.addEventListener("terminal", (message) => {
            const event = parseTerminalEvent(message.data);
            if (!event || event.seq <= fromSeq) {
              return;
            }
            fromSeq = event.seq;
            handlers.onEvent(event);
          });
          eventSource.addEventListener("conversationMessages", (event) => {
            const payload = JSON.parse(event.data) as
              | ConversationStreamPayload
              | unknown[];
            const messages = (
              Array.isArray(payload)
                ? payload
                : Array.isArray(payload.messages)
                  ? payload.messages
                  : []
            ) as ConversationMessage[];
            if (
              !Array.isArray(payload) &&
              Number.isFinite(payload.nextOffset) &&
              typeof payload.nextOffset === "number"
            ) {
              conversationOffset = Math.max(
                conversationOffset,
                Math.floor(payload.nextOffset),
              );
            }

            const done =
              Array.isArray(payload) || typeof payload.done !== "boolean"
                ? true
                : payload.done;
            const phase = conversationBootstrapComplete
              ? "incremental"
              : "bootstrap";
            if (done) {
              conversationBootstrapComplete = true;
            }
            handlers.onConversationMessages?.(messages, {
              messages,
              phase,
              nextOffset: conversationOffset,
              done,
              insertion: "append",
            });
          });
          eventSource.addEventListener("conversationHeartbeat", () => {
            handlers.onConversationHeartbeat?.();
          });
        },
        onDisconnect: handlers.onError,
      });
    },
  };
}
