import type {
  CodexDeckUpdateOutputResponse,
  ConversationMessage,
  Session,
  CodexAppServerEvent,
  TerminalSummary,
  TerminalStreamEvent,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@codex-deck/api";
import type { ConversationHoverSettings } from "../../api/conversation-hover-settings";

export interface ConversationHoverSettingsHandlers {
  onSettings: (settings: ConversationHoverSettings) => void;
  onError?: () => void;
}

export interface SessionsStreamHandlers {
  onSessions: (sessions: Session[]) => void;
  onSessionsUpdate: (sessions: Session[]) => void;
  onSessionsRemoved: (sessionIds: string[]) => void;
  onSkillsChanged?: (payload: { sessionId: string }) => void;
  onCodexAppServerEvent?: (event: CodexAppServerEvent) => void;
  onError?: () => void;
}

export interface CodexDeckUpdateOutputStreamHandlers {
  onOutput: (response: CodexDeckUpdateOutputResponse) => void;
  onError?: () => void;
}

export type ConversationStreamPhase = "bootstrap" | "incremental";

export interface ConversationStreamBatch {
  messages: ConversationMessage[];
  phase: ConversationStreamPhase;
  nextOffset: number;
  done: boolean;
  insertion?: "append" | "prepend";
  historyStartSequence?: number;
  fileId?: string;
  totalMessages?: number;
}

export interface ConversationStreamHandlers {
  onMessages: (
    messages: ConversationMessage[],
    batch?: ConversationStreamBatch,
  ) => void;
  onHeartbeat?: () => void;
  onReset?: () => void;
  onError?: () => void;
}

export interface ConversationStreamSubscriptionOptions {
  initialOffset?: number;
  initialHistoryStartSequence?: number;
  initialFileId?: string;
  onCodexAppServerEvent?: (event: CodexAppServerEvent) => void;
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
  bootstrap?: boolean;
  clientId?: string;
  terminalId: string;
}

export interface WebTransport {
  subscribeConversationHoverSettings: (
    handlers: ConversationHoverSettingsHandlers,
  ) => () => void;
  requestJson: <T>(url: string, init?: RequestInit) => Promise<T>;
  subscribeCodexDeckUpdateOutput: (
    handlers: CodexDeckUpdateOutputStreamHandlers,
  ) => () => void;
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
    options: TerminalStreamSubscriptionOptions,
  ) => () => void;
  notifyConversationMutation?: (sessionId: string) => void;
  notifyWorkflowMutation?: (workflowKey?: string | null) => void;
}
