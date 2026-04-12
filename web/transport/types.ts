import type {
  ConversationMessage,
  Session,
  TerminalSummary,
  TerminalStreamEvent,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@codex-deck/api";

export interface SessionsStreamHandlers {
  onSessions: (sessions: Session[]) => void;
  onSessionsUpdate: (sessions: Session[]) => void;
  onSessionsRemoved: (sessionIds: string[]) => void;
  onSkillsChanged?: (payload: { sessionId: string }) => void;
  onError?: () => void;
}

export type ConversationStreamPhase = "bootstrap" | "incremental";

export interface ConversationStreamBatch {
  messages: ConversationMessage[];
  phase: ConversationStreamPhase;
  nextOffset: number;
  done: boolean;
  insertion?: "append" | "prepend";
}

export interface ConversationStreamHandlers {
  onMessages: (
    messages: ConversationMessage[],
    batch?: ConversationStreamBatch,
  ) => void;
  onHeartbeat?: () => void;
  onError?: () => void;
}

export interface ConversationStreamSubscriptionOptions {
  initialOffset?: number;
}

export interface TerminalStreamHandlers {
  onEvent: (event: TerminalStreamEvent) => void;
  onError?: () => void;
}

export interface TerminalsStreamHandlers {
  onTerminals: (terminals: TerminalSummary[]) => void;
  onError?: () => void;
}

export interface WorkflowsStreamHandlers {
  onWorkflows: (workflows: WorkflowSummary[]) => void;
  onError?: () => void;
}

export interface WorkflowDaemonStatusStreamHandlers {
  onDaemonStatus: (status: WorkflowDaemonStatusResponse) => void;
  onError?: () => void;
}

export interface WorkflowDetailStreamHandlers {
  onWorkflowDetail: (detail: WorkflowDetailResponse) => void;
  onError?: () => void;
}

export interface TerminalStreamSubscriptionOptions {
  fromSeq?: number;
  clientId?: string;
  terminalId: string;
}

export interface WebTransport {
  requestJson: <T>(url: string, init?: RequestInit) => Promise<T>;
  subscribeSessionsStream: (handlers: SessionsStreamHandlers) => () => void;
  subscribeTerminalsStream: (handlers: TerminalsStreamHandlers) => () => void;
  subscribeWorkflowsStream: (handlers: WorkflowsStreamHandlers) => () => void;
  subscribeWorkflowDaemonStatusStream: (
    handlers: WorkflowDaemonStatusStreamHandlers,
  ) => () => void;
  subscribeWorkflowDetailStream: (
    workflowKey: string,
    handlers: WorkflowDetailStreamHandlers,
  ) => () => void;
  subscribeConversationStream: (
    sessionId: string,
    handlers: ConversationStreamHandlers,
    options?: ConversationStreamSubscriptionOptions,
  ) => () => void;
  subscribeTerminalStream: (
    handlers: TerminalStreamHandlers,
    options?: TerminalStreamSubscriptionOptions,
  ) => () => void;
  notifyConversationMutation?: (sessionId: string) => void;
  notifyWorkflowMutation?: (workflowKey?: string | null) => void;
}
