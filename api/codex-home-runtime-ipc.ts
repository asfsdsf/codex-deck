export const CODEX_HOME_RUNTIME_CHILD_ENV = "CODEXDECK_RUNTIME_CHILD";
export const CODEX_HOME_RUNTIME_TRANSLATION_ENV =
  "CODEXDECK_RUNTIME_TRANSLATION_COMMAND";

export interface CodexHomeRuntimeReadyMessage {
  type: "codex-home-runtime-ready";
}

export interface CodexHomeRuntimeStartupErrorMessage {
  type: "codex-home-runtime-startup-error";
  error: string;
}

export interface CodexHomeRuntimeRequestMessage {
  type: "codex-home-runtime-request";
  requestId: string;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  bodyBase64: string | null;
}

export interface CodexHomeRuntimeAbortMessage {
  type: "codex-home-runtime-abort";
  requestId: string;
}

export interface CodexHomeRuntimeResponseCreditMessage {
  type: "codex-home-runtime-response-credit";
  requestId: string;
}

export interface CodexHomeRuntimeResponseStartMessage {
  type: "codex-home-runtime-response-start";
  requestId: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  hasBody: boolean;
}

export interface CodexHomeRuntimeResponseChunkMessage {
  type: "codex-home-runtime-response-chunk";
  requestId: string;
  chunkBase64: string;
}

export interface CodexHomeRuntimeResponseEndMessage {
  type: "codex-home-runtime-response-end";
  requestId: string;
}

export interface CodexHomeRuntimeResponseErrorMessage {
  type: "codex-home-runtime-response-error";
  requestId: string;
  error: string;
}

export type CodexHomeRuntimeParentMessage =
  | CodexHomeRuntimeRequestMessage
  | CodexHomeRuntimeAbortMessage
  | CodexHomeRuntimeResponseCreditMessage;

export type CodexHomeRuntimeChildMessage =
  | CodexHomeRuntimeReadyMessage
  | CodexHomeRuntimeStartupErrorMessage
  | CodexHomeRuntimeResponseStartMessage
  | CodexHomeRuntimeResponseChunkMessage
  | CodexHomeRuntimeResponseEndMessage
  | CodexHomeRuntimeResponseErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function isCodexHomeRuntimeParentMessage(
  value: unknown,
): value is CodexHomeRuntimeParentMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (
    value.type === "codex-home-runtime-abort" ||
    value.type === "codex-home-runtime-response-credit"
  ) {
    return typeof value.requestId === "string";
  }
  return (
    value.type === "codex-home-runtime-request" &&
    typeof value.requestId === "string" &&
    typeof value.url === "string" &&
    typeof value.method === "string" &&
    Array.isArray(value.headers) &&
    (value.bodyBase64 === null || typeof value.bodyBase64 === "string")
  );
}

export function isCodexHomeRuntimeChildMessage(
  value: unknown,
): value is CodexHomeRuntimeChildMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "codex-home-runtime-ready") {
    return true;
  }
  if (value.type === "codex-home-runtime-startup-error") {
    return typeof value.error === "string";
  }
  if (value.type === "codex-home-runtime-response-end") {
    return typeof value.requestId === "string";
  }
  if (value.type === "codex-home-runtime-response-chunk") {
    return (
      typeof value.requestId === "string" &&
      typeof value.chunkBase64 === "string"
    );
  }
  if (value.type === "codex-home-runtime-response-error") {
    return (
      typeof value.requestId === "string" && typeof value.error === "string"
    );
  }
  return (
    value.type === "codex-home-runtime-response-start" &&
    typeof value.requestId === "string" &&
    typeof value.status === "number" &&
    typeof value.statusText === "string" &&
    Array.isArray(value.headers) &&
    typeof value.hasBody === "boolean"
  );
}
