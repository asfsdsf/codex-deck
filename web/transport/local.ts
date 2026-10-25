import type {
  CodexAppServerEvent,
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
  CodexDeckUpdateOutputStreamHandlers,
  ConversationStreamHandlers,
  ConversationStreamSubscriptionOptions,
  ConversationHoverSettingsHandlers,
  SessionsStreamHandlers,
  TerminalsStreamHandlers,
  TerminalStreamHandlers,
  TerminalStreamSubscriptionOptions,
  WorkflowDaemonStatusStreamHandlers,
  WorkflowDetailStreamHandlers,
  WorkflowsStreamHandlers,
  WebTransport,
} from "./types";
import { addCodexHomeToApiUrl } from "../codex-home-scope";

import { subscribeLocalConversation } from "./local-conversation";
import type { ConversationHoverSettings } from "../../api/conversation-hover-settings";

const WORKFLOW_DETAIL_POLL_INTERVAL_MS = 3_000;
const WORKFLOW_DAEMON_STATUS_POLL_INTERVAL_MS = 5_000;

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
  const hoverSettingsSubscribers = new Set<ConversationHoverSettingsHandlers>();
  let lastHoverSettings: ConversationHoverSettings | null = null;
  const terminalsStreamSubscribers = new Set<TerminalsStreamHandlers>();
  const conversationAppServerSubscribers = new Map<
    string,
    Set<(event: CodexAppServerEvent) => void>
  >();
  const workflowsStreamSubscribers = new Set<{
    onWorkflows: (workflows: WorkflowSummary[]) => void;
    onWorkflowsUpdate: (workflows: WorkflowSummary[]) => void;
    onWorkflowsRemoved: (workflowKeys: string[]) => void;
    onError?: () => void;
  }>();
  let unsubscribeSharedRealtimeStream: (() => void) | null = null;
  let sharedRealtimeUrl: string | null = null;

  const stopSharedRealtimeStreamIfIdle = () => {
    if (
      !unsubscribeSharedRealtimeStream ||
      sessionsStreamSubscribers.size > 0 ||
      hoverSettingsSubscribers.size > 0 ||
      terminalsStreamSubscribers.size > 0 ||
      conversationAppServerSubscribers.size > 0 ||
      workflowsStreamSubscribers.size > 0
    ) {
      return;
    }

    unsubscribeSharedRealtimeStream();
    unsubscribeSharedRealtimeStream = null;
    sharedRealtimeUrl = null;
  };

  const ensureSharedRealtimeStream = () => {
    const url = addCodexHomeToApiUrl("/api/sessions/stream");
    if (unsubscribeSharedRealtimeStream && sharedRealtimeUrl === url) {
      return;
    }
    unsubscribeSharedRealtimeStream?.();
    sharedRealtimeUrl = url;

    // Keep a single local EventSource for global realtime state so two visible
    // pages do not exhaust the browser's per-origin connection budget.
    unsubscribeSharedRealtimeStream = createReconnectingEventSource({
      createUrl: () => url,
      configure: (eventSource) => {
        eventSource.addEventListener("sessions", (event) => {
          const sessions = JSON.parse(event.data);
          for (const subscriber of sessionsStreamSubscribers) {
            subscriber.onSessions(sessions);
          }
        });
        eventSource.addEventListener("hoverSettings", (event) => {
          lastHoverSettings = JSON.parse(
            event.data,
          ) as ConversationHoverSettings;
          for (const subscriber of hoverSettingsSubscribers) {
            subscriber.onSettings(lastHoverSettings);
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
        eventSource.addEventListener("diffGuides", (event) => {
          const guides = JSON.parse(event.data);
          for (const subscriber of sessionsStreamSubscribers)
            subscriber.onDiffGuides?.(guides);
        });
        eventSource.addEventListener("codexAppServerEvent", (event) => {
          const payload = JSON.parse(event.data) as CodexAppServerEvent;
          for (const subscriber of sessionsStreamSubscribers) {
            subscriber.onCodexAppServerEvent?.(payload);
          }
          if (!payload.threadId) return;
          for (const subscriber of conversationAppServerSubscribers.get(
            payload.threadId,
          ) ?? []) {
            subscriber(payload);
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
        for (const subscriber of hoverSettingsSubscribers) {
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
    subscribeConversationHoverSettings: (handlers) => {
      hoverSettingsSubscribers.add(handlers);
      if (lastHoverSettings) handlers.onSettings(lastHoverSettings);
      ensureSharedRealtimeStream();
      return () => {
        hoverSettingsSubscribers.delete(handlers);
        stopSharedRealtimeStreamIfIdle();
      };
    },
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

    subscribeCodexDeckUpdateOutput(
      handlers: CodexDeckUpdateOutputStreamHandlers,
    ): () => void {
      return createReconnectingEventSource({
        createUrl: () => "/api/codex-deck/update/stream",
        configure: (eventSource) => {
          eventSource.addEventListener("updateOutput", (event) => {
            handlers.onOutput(JSON.parse(event.data));
          });
        },
        onDisconnect: handlers.onError,
      });
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
      let unregisterAppServerListener: (() => void) | null = null;

      if (options.onCodexAppServerEvent) {
        const listeners =
          conversationAppServerSubscribers.get(sessionId) ??
          new Set<(event: CodexAppServerEvent) => void>();
        listeners.add(options.onCodexAppServerEvent);
        conversationAppServerSubscribers.set(sessionId, listeners);
        ensureSharedRealtimeStream();
        unregisterAppServerListener = () => {
          listeners.delete(options.onCodexAppServerEvent!);
          if (listeners.size === 0) {
            conversationAppServerSubscribers.delete(sessionId);
          }
        };
      }

      const unsubscribeConversationStream = subscribeLocalConversation(
        sessionId,
        handlers,
        options,
      );

      return () => {
        unregisterAppServerListener?.();
        unsubscribeConversationStream();
        stopSharedRealtimeStreamIfIdle();
      };
    },

    subscribeTerminalStream(
      handlers: TerminalStreamHandlers,
      options: TerminalStreamSubscriptionOptions,
    ): () => void {
      let fromSeq = 0;
      return createReconnectingEventSource({
        createUrl: () => {
          const params = new URLSearchParams({
            fromSeq: String(fromSeq),
          });
          if (options.bootstrap) {
            params.set("bootstrap", "1");
          }
          if (options.clientId?.trim()) {
            params.set("clientId", options.clientId.trim());
          }
          return addCodexHomeToApiUrl(
            `/api/terminals/${encodeURIComponent(options.terminalId)}/stream?${params.toString()}`,
          );
        },
        configure: (eventSource) => {
          eventSource.addEventListener("terminal", (message) => {
            const event = parseTerminalEvent(message.data);
            if (
              !event ||
              (event.type === "bootstrap"
                ? event.seq < fromSeq
                : event.seq <= fromSeq)
            ) {
              return;
            }
            fromSeq = event.seq;
            handlers.onEvent(event);
          });
        },
        onDisconnect: handlers.onError,
      });
    },
  };
}
