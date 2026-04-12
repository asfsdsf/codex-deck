import { RemoteClient } from "../remote-client";
import { createLocalTransport } from "./local";
import { createRemoteTransport } from "./remote";
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
} from "./types";

export { createPollingSubscription } from "./shared";
export type {
  ConversationStreamBatch,
  ConversationStreamHandlers,
  ConversationStreamPhase,
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

export const remoteClient = new RemoteClient();

const localTransport = createLocalTransport();
const remoteTransport = createRemoteTransport(remoteClient);

function getTransport() {
  return remoteClient.isConnected() ? remoteTransport : localTransport;
}

export function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  return getTransport().requestJson<T>(url, init);
}

export function subscribeSessionsStream(
  handlers: SessionsStreamHandlers,
): () => void {
  return getTransport().subscribeSessionsStream(handlers);
}

export function subscribeConversationStream(
  sessionId: string,
  handlers: ConversationStreamHandlers,
  options: ConversationStreamSubscriptionOptions = {},
): () => void {
  return getTransport().subscribeConversationStream(
    sessionId,
    handlers,
    options,
  );
}

export function subscribeWorkflowsStream(
  handlers: WorkflowsStreamHandlers,
): () => void {
  return getTransport().subscribeWorkflowsStream(handlers);
}

export function subscribeWorkflowDaemonStatusStream(
  handlers: WorkflowDaemonStatusStreamHandlers,
): () => void {
  return getTransport().subscribeWorkflowDaemonStatusStream(handlers);
}

export function subscribeWorkflowDetailStream(
  workflowKey: string,
  handlers: WorkflowDetailStreamHandlers,
): () => void {
  return getTransport().subscribeWorkflowDetailStream(workflowKey, handlers);
}

export function subscribeTerminalsStream(
  handlers: TerminalsStreamHandlers,
): () => void {
  return getTransport().subscribeTerminalsStream(handlers);
}

export function subscribeTerminalStream(
  handlers: TerminalStreamHandlers,
  options: TerminalStreamSubscriptionOptions = {},
): () => void {
  return getTransport().subscribeTerminalStream(handlers, options);
}

export function notifyConversationMutation(sessionId: string): void {
  getTransport().notifyConversationMutation?.(sessionId);
}

export function notifyWorkflowMutation(workflowKey?: string | null): void {
  getTransport().notifyWorkflowMutation?.(workflowKey);
}

export function isRemoteLatencyLoggingEnabled(): boolean {
  return remoteClient.isLatencyLoggingEnabled();
}

export function setRemoteLatencyLoggingEnabled(enabled: boolean): void {
  remoteClient.setLatencyLoggingEnabled(enabled);
}
