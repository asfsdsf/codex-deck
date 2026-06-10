export type CodexHookTrustStatus =
  | "managed"
  | "untrusted"
  | "trusted"
  | "modified";

export type CodexHookSource =
  | "system"
  | "user"
  | "project"
  | "mdm"
  | "sessionFlags"
  | "plugin"
  | "cloudRequirements"
  | "cloudManagedConfig"
  | "legacyManagedConfigFile"
  | "legacyManagedConfigMdm"
  | "unknown";

export type CodexHookEventName =
  | "preToolUse"
  | "permissionRequest"
  | "postToolUse"
  | "preCompact"
  | "postCompact"
  | "sessionStart"
  | "userPromptSubmit"
  | "subagentStart"
  | "subagentStop"
  | "stop";

export type CodexHookHandlerType = "command" | "prompt" | "agent";

export interface CodexHookErrorInfo {
  path: string;
  message: string;
}

export interface CodexHookMetadata {
  key: string;
  eventName: CodexHookEventName;
  handlerType: CodexHookHandlerType;
  matcher: string | null;
  command: string | null;
  timeoutSec: number;
  statusMessage: string | null;
  sourcePath: string;
  source: CodexHookSource;
  pluginId: string | null;
  displayOrder: number;
  enabled: boolean;
  isManaged: boolean;
  currentHash: string;
  trustStatus: CodexHookTrustStatus;
}

export interface SessionHooksResponse {
  sessionId: string;
  projectPath: string | null;
  cwd: string | null;
  hooks: CodexHookMetadata[];
  warnings: string[];
  errors: CodexHookErrorInfo[];
  unavailableReason: string | null;
}

export interface SessionHookStateUpdate {
  key: string;
  enabled?: boolean;
  trustedHash?: string | null;
}

export interface SessionHooksConfigWriteRequest {
  updates: SessionHookStateUpdate[];
}

export interface SessionHooksConfigWriteResponse {
  sessionId: string;
  updates: SessionHookStateUpdate[];
  ok: boolean;
}
