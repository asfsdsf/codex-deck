import { RemoteClient } from "../remote-client";
import { getActiveCodexHomeId } from "../codex-home-scope";
import { createLocalTransport } from "./local";
import { createRemoteTransport } from "./remote";
import { requestLocalJson } from "./shared";
import type {
  ConversationHoverSettingsHandlers,
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
} from "./types";

export { createPollingSubscription } from "./shared";
export type {
  CodexDeckUpdateOutputStreamHandlers,
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

// Session and conversation SSE already hold two HTTP/1.1 connections.
// Leave room for user actions while session selection fans out slow RPC reads.
const MAX_LOCAL_THREAD_SNAPSHOTS = 2;
let activeThreadSnapshots = 0;
const waitingThreadSnapshots: (() => void)[] = [];

export async function requestThreadSnapshot<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  if (remoteClient.isConnected())
    return remoteTransport.requestJson<T>(url, init);

  const homeId = getActiveCodexHomeId();
  if (activeThreadSnapshots < MAX_LOCAL_THREAD_SNAPSHOTS) {
    activeThreadSnapshots++;
  } else {
    await new Promise<void>((resolve) => waitingThreadSnapshots.push(resolve));
  }
  try {
    return await requestLocalJson<T>(url, init, homeId);
  } finally {
    const next = waitingThreadSnapshots.shift();
    if (next) next();
    else activeThreadSnapshots--;
  }
}

export function subscribeConversationHoverSettings(
  handlers: ConversationHoverSettingsHandlers,
): () => void {
  return getTransport().subscribeConversationHoverSettings(handlers);
}

export function subscribeCodexDeckUpdateOutput(
  handlers: CodexDeckUpdateOutputStreamHandlers,
): () => void {
  return getTransport().subscribeCodexDeckUpdateOutput(handlers);
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
  options: TerminalStreamSubscriptionOptions,
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
