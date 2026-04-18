import type {
  ConversationMessage,
  CodexCollaborationModeOption,
  CodexThreadStateResponse,
  CodexThreadSummary,
  CodexThreadNameSetRequest,
  CodexThreadNameSetResponse,
  CodexThreadForkResponse,
  CodexThreadCompactResponse,
  CodexThreadAgentListResponse,
  CodexThreadSummariesRequest,
  CodexThreadSummariesResponse,
  CodexModelOption,
  CodexConfigDefaultsResponse,
  CodexSessionContextResponse,
  DeleteSessionResponse,
  FixDanglingSessionResponse,
  SessionExistsResponse,
  SessionFileContentResponse,
  SessionFileSearchResponse,
  SessionFileTreeResponse,
  SessionFileTreeNodesResponse,
  SessionSkillConfigWriteRequest,
  CreateWorkflowRequest,
  SystemContextResponse,
  WorkflowActionResponse,
  WorkflowBindSessionRequest,
  WorkflowControlMessageRequest,
  WorkflowCreateResponse,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowSessionLookupResult,
  WorkflowLogResponse,
  WorkflowSessionLookupResponse,
  WorkflowSessionRoleSummary,
  WorkflowSessionRolesResponse,
  WorkflowSummary,
  SessionSkillConfigWriteResponse,
  SessionSkillsResponse,
  TerminalListResponse,
  TerminalSummary,
  TerminalBindingResponse,
  TerminalBindSessionRequest,
  TerminalSessionRoleSummary,
  TerminalSessionRolesResponse,
  CreateTerminalRequest,
  TerminalCommandResponse,
  TerminalInputResponse,
  TerminalInputRequest,
  TerminalPersistMessageActionRequest,
  TerminalPersistMessageActionResponse,
  TerminalResizeRequest,
  TerminalSnapshotResponse,
  SessionDiffMode,
  SessionDiffResponse,
  SessionTerminalRunOutputResponse,
  SessionTerminalRunsResponse,
  CreateCodexThreadRequest,
  CreateCodexThreadResponse,
  CodexUserInputRequest,
  CodexUserInputResponsePayload,
  CodexApprovalRequest,
  CodexApprovalResponsePayload,
  SendCodexMessageRequest,
  SendCodexMessageResponse,
} from "@codex-deck/api";
import { getRemoteAuthHint } from "@zuoyehaoduoa/wire";
import type {
  RemoteMachineDescription,
  RemoteServerTrustPins,
} from "./remote-client";
export type { RemoteServerTrustPins };
import {
  isRemoteLatencyLoggingEnabled as isRemoteLatencyLoggingEnabledTransport,
  notifyConversationMutation,
  notifyWorkflowMutation as notifyWorkflowMutationTransport,
  remoteClient,
  requestJson,
  setRemoteLatencyLoggingEnabled as setRemoteLatencyLoggingEnabledTransport,
  subscribeConversationStream as subscribeTransportConversationStream,
  subscribeSessionsStream as subscribeTransportSessionsStream,
  subscribeTerminalsStream as subscribeTransportTerminalsStream,
  subscribeTerminalStream as subscribeTransportTerminalStream,
  subscribeWorkflowDaemonStatusStream as subscribeTransportWorkflowDaemonStatusStream,
  subscribeWorkflowDetailStream as subscribeTransportWorkflowDetailStream,
  subscribeWorkflowsStream as subscribeTransportWorkflowsStream,
} from "./transport";
import { readRemoteConversationSnapshot } from "./transport/remote";
import type {
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
} from "./transport";

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
} from "./transport";
export type { RemoteMachineDescription } from "./remote-client";

interface CodexModelsResponse {
  models: CodexModelOption[];
}

export interface RemoteAdminSetupToken {
  id: string;
  label: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

interface CodexCollaborationModesResponse {
  modes: CodexCollaborationModeOption[];
}

interface InterruptCodexThreadResponse {
  ok: boolean;
}

interface CodexUserInputRequestsResponse {
  requests: CodexUserInputRequest[];
}

interface CodexApprovalRequestsResponse {
  requests: CodexApprovalRequest[];
}

export async function getSystemContext(): Promise<SystemContextResponse> {
  return requestJson<SystemContextResponse>("/api/system/context");
}

const READONLY_CLI_CACHE_TTL_MS = 30_000;
const THREAD_STATE_CACHE_TTL_MS = 250;
const SESSION_ROLE_CACHE_TTL_MS = 250;
const WORKFLOW_SESSION_LOOKUP_CACHE_TTL_MS = 250;

interface TimedCacheEntry<T> {
  value: T;
  expiresAt: number;
}

function createTimedLoader<T>(ttlMs: number, load: () => Promise<T>) {
  let cache: TimedCacheEntry<T> | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    async load(): Promise<T> {
      if (cache && cache.expiresAt > Date.now()) {
        return cache.value;
      }

      if (inFlight) {
        return inFlight;
      }

      inFlight = load()
        .then((value) => {
          cache = {
            value,
            expiresAt: Date.now() + ttlMs,
          };
          return value;
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    },

    clear(): void {
      cache = null;
      inFlight = null;
    },
  };
}

function createKeyedTimedLoader<T>(ttlMs: number) {
  const cache = new Map<string, TimedCacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    async getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }

      const existing = inFlight.get(key);
      if (existing) {
        return existing;
      }

      const promise = load()
        .then((value) => {
          cache.set(key, {
            value,
            expiresAt: Date.now() + ttlMs,
          });
          return value;
        })
        .finally(() => {
          inFlight.delete(key);
        });

      inFlight.set(key, promise);
      return promise;
    },

    clearKey(key: string): void {
      cache.delete(key);
      inFlight.delete(key);
    },

    clearMatching(matcher: (key: string) => boolean): void {
      for (const key of cache.keys()) {
        if (matcher(key)) {
          cache.delete(key);
        }
      }
      for (const key of inFlight.keys()) {
        if (matcher(key)) {
          inFlight.delete(key);
        }
      }
    },
  };
}

const loadCodexModels = createTimedLoader(READONLY_CLI_CACHE_TTL_MS, async () => {
  const payload = await requestJson<CodexModelsResponse>("/api/codex/models");
  return Array.isArray(payload.models) ? payload.models : [];
});

const loadCodexCollaborationModes = createTimedLoader(
  READONLY_CLI_CACHE_TTL_MS,
  async () => {
    const payload = await requestJson<CodexCollaborationModesResponse>(
      "/api/codex/collaboration-modes",
    );
    return Array.isArray(payload.modes) ? payload.modes : [];
  },
);

const loadCodexConfigDefaults = createTimedLoader(
  READONLY_CLI_CACHE_TTL_MS,
  () => requestJson<CodexConfigDefaultsResponse>("/api/codex/defaults"),
);

const codexThreadStateLoader =
  createKeyedTimedLoader<CodexThreadStateResponse>(THREAD_STATE_CACHE_TTL_MS);
const workflowBySessionLoader =
  createKeyedTimedLoader<WorkflowSessionLookupResponse | null>(
    WORKFLOW_SESSION_LOOKUP_CACHE_TTL_MS,
  );
const workflowSessionRolesLoader =
  createKeyedTimedLoader<WorkflowSessionRoleSummary[]>(SESSION_ROLE_CACHE_TTL_MS);
const terminalSessionRolesLoader =
  createKeyedTimedLoader<TerminalSessionRoleSummary[]>(SESSION_ROLE_CACHE_TTL_MS);

function resetApiRequestCaches(): void {
  loadCodexModels.clear();
  loadCodexCollaborationModes.clear();
  loadCodexConfigDefaults.clear();
  codexThreadStateLoader.clearMatching(() => true);
  workflowBySessionLoader.clearMatching(() => true);
  workflowSessionRolesLoader.clearMatching(() => true);
  terminalSessionRolesLoader.clearMatching(() => true);
}

export const __TEST_ONLY__ = {
  resetApiRequestCaches,
};

async function requestJsonAndNotifyConversation<T>(
  sessionId: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await requestJson<T>(url, init);
  notifyConversationMutation(sessionId);
  return response;
}

async function requestJsonAndNotifyWorkflow<T>(
  workflowKey: string | null | undefined,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await requestJson<T>(url, init);
  notifyWorkflowMutationTransport(workflowKey);
  return response;
}

async function requestRemoteServerJson<T>(
  serverUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(
    new URL(path, serverUrl.trim().replace(/\/+$/, "")),
    {
      credentials: "include",
      ...init,
    },
  );
  const text = await response.text();
  let payload: (T | { error?: string; code?: string; text?: string }) | null =
    null;

  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as
        | T
        | {
            error?: string;
            code?: string;
            text?: string;
          };
    } catch {
      payload = { text };
    }
  }

  if (!response.ok) {
    const code =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof (payload as { code?: string }).code === "string"
        ? (payload as { code: string }).code
        : null;
    const error =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof (payload as { error?: string }).error === "string"
        ? (payload as { error: string }).error
        : payload &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            typeof (payload as { text?: string }).text === "string"
          ? response.headers.get("content-type")?.includes("text/html")
            ? `Remote server returned an HTML error page (${response.status}). The remote tunnel or proxy may be unstable.`
            : `Remote server returned a non-JSON response (${response.status}, ${response.headers.get("content-type") || "unknown"}): ${(payload as { text: string }).text.replace(/\s+/g, " ").trim().slice(0, 200)}`
          : null;
    const requestError = new Error(
      error ?? `Request failed with status ${response.status}`,
    ) as Error & {
      cause?: { code: string | null; status: number; error: string | null };
    };
    requestError.cause = {
      code,
      status: response.status,
      error: typeof error === "string" ? error : null,
    };
    throw requestError;
  }

  if (payload === null) {
    return {} as T;
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    "text" in payload &&
    !("error" in payload) &&
    !("code" in payload)
  ) {
    throw new Error(
      `Remote server returned a non-JSON response (${response.headers.get("content-type") || "unknown"}): ${String(
        (payload as { text: string }).text,
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200)}`,
    );
  }

  return payload as T;
}

export function isRemoteTransportEnabled(): boolean {
  return remoteClient.isConnected();
}

export function isRemoteAccountAuthenticated(): boolean {
  return remoteClient.isAuthenticated();
}

export function hasSavedRemoteAccount(serverUrl: string): boolean {
  return remoteClient.hasSavedLogin(serverUrl);
}

export async function restoreSavedRemoteAccount(
  serverUrl: string,
  pins?: RemoteServerTrustPins,
): Promise<RemoteMachineDescription[] | null> {
  return remoteClient.restoreSavedLogin(serverUrl, pins);
}

export async function loginRemoteWithCredentials(
  serverUrl: string,
  username: string,
  password: string,
  pins?: RemoteServerTrustPins,
): Promise<RemoteMachineDescription[]> {
  return remoteClient.login(serverUrl, username, password, pins);
}

export async function loginRemoteAdmin(
  serverUrl: string,
  password: string,
): Promise<void> {
  try {
    await requestRemoteServerJson<{ success: boolean }>(
      serverUrl,
      "/v1/admin/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      },
    );
  } catch (error) {
    const errorWithCause = error as Error & { cause?: unknown };
    const cause =
      errorWithCause.cause &&
      typeof errorWithCause.cause === "object" &&
      !Array.isArray(errorWithCause.cause)
        ? (errorWithCause.cause as { code?: string; error?: string })
        : null;
    throw new Error(
      getRemoteAuthHint({
        context: "admin",
        code: cause?.code ?? null,
        error: cause?.error ?? (error instanceof Error ? error.message : null),
      }),
    );
  }
}

export async function logoutRemoteAdmin(serverUrl: string): Promise<void> {
  await requestRemoteServerJson<{ success: boolean }>(
    serverUrl,
    "/v1/admin/auth/logout",
    {
      method: "POST",
    },
  );
}

export async function listRemoteAdminSetupTokens(
  serverUrl: string,
): Promise<RemoteAdminSetupToken[]> {
  const payload = await requestRemoteServerJson<{
    tokens: RemoteAdminSetupToken[];
  }>(serverUrl, "/v1/admin/setup-tokens");
  return Array.isArray(payload.tokens) ? payload.tokens : [];
}

export async function createRemoteAdminSetupToken(
  serverUrl: string,
  label: string,
): Promise<{ token: RemoteAdminSetupToken; rawToken: string }> {
  return requestRemoteServerJson<{
    token: RemoteAdminSetupToken;
    rawToken: string;
  }>(serverUrl, "/v1/admin/setup-tokens", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ label }),
  });
}

export async function updateRemoteAdminSetupToken(
  serverUrl: string,
  tokenId: string,
  input: { label?: string; enabled?: boolean },
): Promise<RemoteAdminSetupToken> {
  const payload = await requestRemoteServerJson<{
    success: boolean;
    token: RemoteAdminSetupToken;
  }>(serverUrl, `/v1/admin/setup-tokens/${encodeURIComponent(tokenId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return payload.token;
}

export async function regenerateRemoteAdminSetupToken(
  serverUrl: string,
  tokenId: string,
): Promise<{ token: RemoteAdminSetupToken; rawToken: string }> {
  return requestRemoteServerJson<{
    token: RemoteAdminSetupToken;
    rawToken: string;
  }>(
    serverUrl,
    `/v1/admin/setup-tokens/${encodeURIComponent(tokenId)}/regenerate`,
    {
      method: "POST",
    },
  );
}

export async function deleteRemoteAdminSetupToken(
  serverUrl: string,
  tokenId: string,
): Promise<void> {
  await requestRemoteServerJson<{ success: boolean }>(
    serverUrl,
    `/v1/admin/setup-tokens/${encodeURIComponent(tokenId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function rotateRemoteAdminPassword(
  serverUrl: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  await requestRemoteServerJson<{ success: boolean }>(
    serverUrl,
    "/v1/admin/password",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ oldPassword, newPassword }),
    },
  );
}

export async function disconnectRemoteTransport(): Promise<void> {
  await remoteClient.disconnect();
}

export function subscribeRemoteTransport(listener: () => void): () => void {
  return remoteClient.subscribe(listener);
}

export function getRemoteMachines(): RemoteMachineDescription[] {
  return remoteClient.getMachines();
}

export async function refreshRemoteMachines(): Promise<
  RemoteMachineDescription[]
> {
  return remoteClient.refreshMachines();
}

export function getSelectedRemoteMachineId(): string | null {
  return remoteClient.getSelectedMachineId();
}

export function setSelectedRemoteMachineId(machineId: string | null): void {
  remoteClient.setSelectedMachineId(machineId);
}

export function isRemoteLatencyLoggingEnabled(): boolean {
  return isRemoteLatencyLoggingEnabledTransport();
}

export function setRemoteLatencyLoggingEnabled(enabled: boolean): void {
  setRemoteLatencyLoggingEnabledTransport(enabled);
}

export async function listProjects(): Promise<string[]> {
  return requestJson<string[]>("/api/projects");
}

export async function listWorkflows(
  project?: string | null,
): Promise<WorkflowSummary[]> {
  const params = new URLSearchParams();
  if (project) {
    params.set("project", project);
  }
  const path =
    params.size > 0 ? `/api/workflows?${params.toString()}` : "/api/workflows";
  const response = await requestJson<{ workflows: WorkflowSummary[] }>(path);
  return Array.isArray(response.workflows) ? response.workflows : [];
}

export async function getWorkflowDetail(
  key: string,
): Promise<WorkflowDetailResponse> {
  return requestJson<WorkflowDetailResponse>(
    `/api/workflows/${encodeURIComponent(key)}`,
  );
}

export async function getWorkflowBySession(
  sessionId: string,
): Promise<WorkflowSessionLookupResponse | null> {
  const normalizedSessionId = sessionId.trim();
  return workflowBySessionLoader.getOrLoad(normalizedSessionId, async () => {
    const response = await requestJson<WorkflowSessionLookupResult>(
      `/api/workflows/by-session/${encodeURIComponent(normalizedSessionId)}`,
    );
    return response.match ?? null;
  });
}

export async function getWorkflowSessionRoles(
  sessionIds: string[],
): Promise<WorkflowSessionRoleSummary[]> {
  const normalizedSessionIds = [...sessionIds]
    .map((sessionId) => sessionId.trim())
    .filter((sessionId) => sessionId.length > 0)
    .sort();
  const cacheKey = normalizedSessionIds.join("|");
  return workflowSessionRolesLoader.getOrLoad(cacheKey, async () => {
    const response = await requestJson<WorkflowSessionRolesResponse>(
      "/api/workflows/session-roles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionIds: normalizedSessionIds }),
      },
    );
    return Array.isArray(response.sessions) ? response.sessions : [];
  });
}

export async function getWorkflowLog(
  key: string,
  options: { scope: "scheduler" | "task" | "daemon"; taskId?: string | null },
): Promise<WorkflowLogResponse> {
  const params = new URLSearchParams({ scope: options.scope });
  if (options.taskId) {
    params.set("taskId", options.taskId);
  }
  return requestJson<WorkflowLogResponse>(
    `/api/workflows/${encodeURIComponent(key)}/log?${params.toString()}`,
  );
}

export async function getWorkflowDaemonStatus(): Promise<WorkflowDaemonStatusResponse> {
  return requestJson<WorkflowDaemonStatusResponse>(
    "/api/workflows/daemon-status",
  );
}

export async function createWorkflow(
  input: CreateWorkflowRequest,
): Promise<WorkflowCreateResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowCreateResponse>(
    null,
    "/api/workflows/create",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function deleteWorkflow(
  key: string,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
}

export async function validateWorkflow(
  key: string,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/validate`,
    { method: "POST" },
  );
}

export async function reconcileWorkflow(
  key: string,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/reconcile`,
    { method: "POST" },
  );
}

export async function triggerWorkflow(
  key: string,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/trigger`,
    { method: "POST" },
  );
}

export async function stopWorkflowProcesses(
  key: string,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/stop-processes`,
    { method: "POST" },
  );
}

export async function launchWorkflowTask(
  key: string,
  taskId: string,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/launch-task`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ taskId }),
    },
  );
}

export async function previewWorkflowMerge(
  key: string,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/merge-preview`,
    { method: "POST" },
  );
}

export async function applyWorkflowMerge(
  key: string,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/merge-apply`,
    { method: "POST" },
  );
}

export async function bindWorkflowSession(
  key: string,
  input: WorkflowBindSessionRequest,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/bound-session`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function sendWorkflowControlMessage(
  key: string,
  input: WorkflowControlMessageRequest,
): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}/control-message`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function startWorkflowDaemon(): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    null,
    "/api/workflows/daemon-start",
    {
      method: "POST",
    },
  );
}

export async function stopWorkflowDaemon(): Promise<WorkflowActionResponse> {
  return requestJsonAndNotifyWorkflow<WorkflowActionResponse>(
    null,
    "/api/workflows/daemon-stop",
    {
      method: "POST",
    },
  );
}

export function subscribeSessionsStream(
  handlers: SessionsStreamHandlers,
): () => void {
  return subscribeTransportSessionsStream(handlers);
}

export function subscribeConversationStream(
  sessionId: string,
  handlers: ConversationStreamHandlers,
  options: ConversationStreamSubscriptionOptions = {},
): () => void {
  return subscribeTransportConversationStream(sessionId, handlers, options);
}

export function subscribeWorkflowsStream(
  handlers: WorkflowsStreamHandlers,
): () => void {
  return subscribeTransportWorkflowsStream(handlers);
}

export function subscribeWorkflowDaemonStatusStream(
  handlers: WorkflowDaemonStatusStreamHandlers,
): () => void {
  return subscribeTransportWorkflowDaemonStatusStream(handlers);
}

export function subscribeWorkflowDetailStream(
  workflowKey: string,
  handlers: WorkflowDetailStreamHandlers,
): () => void {
  return subscribeTransportWorkflowDetailStream(workflowKey, handlers);
}

export function subscribeTerminalStream(
  handlers: TerminalStreamHandlers,
  options: TerminalStreamSubscriptionOptions,
): () => void {
  return subscribeTransportTerminalStream(handlers, options);
}

export function notifyWorkflowMutation(workflowKey?: string | null): void {
  notifyWorkflowMutationTransport(workflowKey);
}

export async function listCodexModels(): Promise<CodexModelOption[]> {
  return loadCodexModels.load();
}

export async function listCodexCollaborationModes(): Promise<
  CodexCollaborationModeOption[]
> {
  return loadCodexCollaborationModes.load();
}

export async function getCodexConfigDefaults(): Promise<CodexConfigDefaultsResponse> {
  return loadCodexConfigDefaults.load();
}

export async function createCodexThread(
  input: CreateCodexThreadRequest,
): Promise<CreateCodexThreadResponse> {
  return requestJson<CreateCodexThreadResponse>("/api/codex/threads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function sendCodexMessage(
  threadId: string,
  input: SendCodexMessageRequest,
): Promise<SendCodexMessageResponse> {
  const normalizedThreadId = threadId.trim();
  codexThreadStateLoader.clearMatching((key) =>
    key.startsWith(`${normalizedThreadId}:`),
  );
  return requestJsonAndNotifyConversation<SendCodexMessageResponse>(
    normalizedThreadId,
    `/api/codex/threads/${encodeURIComponent(normalizedThreadId)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function getCodexThreadState(
  threadId: string,
  turnId?: string | null,
): Promise<CodexThreadStateResponse> {
  const normalizedThreadId = threadId.trim();
  const params = new URLSearchParams();
  if (typeof turnId === "string" && turnId.trim()) {
    params.set("turnId", turnId.trim());
  }
  const query = params.toString();
  const cacheKey = `${normalizedThreadId}:${params.get("turnId") ?? ""}`;
  return codexThreadStateLoader.getOrLoad(cacheKey, () =>
    requestJson<CodexThreadStateResponse>(
      `/api/codex/threads/${encodeURIComponent(normalizedThreadId)}/state${query ? `?${query}` : ""}`,
    ),
  );
}

export async function interruptCodexThread(
  threadId: string,
): Promise<InterruptCodexThreadResponse> {
  const normalizedThreadId = threadId.trim();
  codexThreadStateLoader.clearMatching((key) =>
    key.startsWith(`${normalizedThreadId}:`),
  );
  return requestJsonAndNotifyConversation<InterruptCodexThreadResponse>(
    normalizedThreadId,
    `/api/codex/threads/${encodeURIComponent(normalizedThreadId)}/interrupt`,
    {
      method: "POST",
    },
  );
}

export async function setCodexThreadName(
  threadId: string,
  input: CodexThreadNameSetRequest,
): Promise<CodexThreadNameSetResponse> {
  return requestJson<CodexThreadNameSetResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/name`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function forkCodexThread(
  threadId: string,
): Promise<CodexThreadForkResponse> {
  return requestJson<CodexThreadForkResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/fork`,
    {
      method: "POST",
    },
  );
}

export async function compactCodexThread(
  threadId: string,
): Promise<CodexThreadCompactResponse> {
  return requestJson<CodexThreadCompactResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/compact`,
    {
      method: "POST",
    },
  );
}

export async function listCodexAgentThreads(
  threadId: string,
): Promise<CodexThreadSummary[]> {
  const payload = await requestJson<CodexThreadAgentListResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/agent-threads`,
  );
  return Array.isArray(payload.threads) ? payload.threads : [];
}

export async function getCodexThreadSummaries(
  input: CodexThreadSummariesRequest,
): Promise<CodexThreadSummariesResponse> {
  return requestJson<CodexThreadSummariesResponse>(
    "/api/codex/threads/summaries",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function listCodexUserInputRequests(
  threadId: string,
): Promise<CodexUserInputRequest[]> {
  const payload = await requestJson<CodexUserInputRequestsResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/requests/user-input`,
  );
  return Array.isArray(payload.requests) ? payload.requests : [];
}

export async function respondCodexUserInputRequest(
  threadId: string,
  requestId: string,
  response: CodexUserInputResponsePayload,
): Promise<{ ok: boolean }> {
  return requestJsonAndNotifyConversation<{ ok: boolean }>(
    threadId,
    `/api/codex/threads/${encodeURIComponent(threadId)}/requests/user-input/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(response),
    },
  );
}

export async function listCodexApprovalRequests(
  threadId: string,
): Promise<CodexApprovalRequest[]> {
  const payload = await requestJson<CodexApprovalRequestsResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/requests/approvals`,
  );
  return Array.isArray(payload.requests) ? payload.requests : [];
}

export async function respondCodexApprovalRequest(
  threadId: string,
  requestId: string,
  response: CodexApprovalResponsePayload,
): Promise<{ ok: boolean }> {
  return requestJsonAndNotifyConversation<{ ok: boolean }>(
    threadId,
    `/api/codex/threads/${encodeURIComponent(threadId)}/requests/approvals/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(response),
    },
  );
}

export async function getSessionContext(
  sessionId: string,
): Promise<CodexSessionContextResponse> {
  return requestJson<CodexSessionContextResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/context`,
  );
}

export async function getSessionExists(
  sessionId: string,
): Promise<SessionExistsResponse> {
  return requestJson<SessionExistsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/exists`,
  );
}

export async function deleteSession(
  sessionId: string,
  clientId?: string,
): Promise<DeleteSessionResponse> {
  const params = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return requestJson<DeleteSessionResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}${params}`,
    {
      method: "DELETE",
    },
  );
}

export async function fixDanglingSession(
  sessionId: string,
): Promise<FixDanglingSessionResponse> {
  return requestJsonAndNotifyConversation<FixDanglingSessionResponse>(
    sessionId,
    `/api/sessions/${encodeURIComponent(sessionId)}/fix-dangling`,
    {
      method: "POST",
    },
  );
}

export async function getConversation(
  sessionId: string,
): Promise<ConversationMessage[]> {
  if (remoteClient.isConnected()) {
    return readRemoteConversationSnapshot(remoteClient, sessionId);
  }

  return requestJson<ConversationMessage[]>(
    `/api/conversation/${encodeURIComponent(sessionId)}`,
  );
}

export async function getSessionDiff(
  sessionId: string,
  mode: Exclude<SessionDiffMode, "file-tree">,
): Promise<SessionDiffResponse> {
  const params = new URLSearchParams({
    mode,
  });
  return requestJson<SessionDiffResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/diff?${params.toString()}`,
  );
}

export async function getWorkflowProjectDiff(
  workflowKey: string,
  mode: Exclude<SessionDiffMode, "file-tree">,
): Promise<SessionDiffResponse> {
  const params = new URLSearchParams({
    mode,
  });
  return requestJson<SessionDiffResponse>(
    `/api/workflow-project/${encodeURIComponent(workflowKey)}/diff?${params.toString()}`,
  );
}

export async function getSessionTerminalRuns(
  sessionId: string,
): Promise<SessionTerminalRunsResponse> {
  return requestJson<SessionTerminalRunsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminal-runs`,
  );
}

export async function getSessionTerminalRunOutput(
  sessionId: string,
  processId: string,
): Promise<SessionTerminalRunOutputResponse> {
  return requestJson<SessionTerminalRunOutputResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminal-runs/${encodeURIComponent(processId)}`,
  );
}

export async function getSessionSkills(
  sessionId: string,
): Promise<SessionSkillsResponse> {
  return requestJson<SessionSkillsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/skills`,
  );
}

export async function setSessionSkillEnabled(
  sessionId: string,
  input: SessionSkillConfigWriteRequest,
): Promise<SessionSkillConfigWriteResponse> {
  return requestJson<SessionSkillConfigWriteResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/skills/config`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function cleanSessionBackgroundTerminalRuns(
  sessionId: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/terminal-runs/clean`,
    {
      method: "POST",
    },
  );
}

export async function listActiveTerminals(): Promise<TerminalSummary[]> {
  const response = await requestJson<TerminalListResponse>("/api/terminals");
  return response.terminals;
}

export async function bindTerminalSession(
  terminalId: string,
  input: TerminalBindSessionRequest,
): Promise<TerminalBindingResponse> {
  return requestJson<TerminalBindingResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/binding`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function getTerminalSessionRoles(
  sessionIds: string[],
): Promise<TerminalSessionRoleSummary[]> {
  const normalizedSessionIds = [...sessionIds]
    .map((sessionId) => sessionId.trim())
    .filter((sessionId) => sessionId.length > 0)
    .sort();
  const cacheKey = normalizedSessionIds.join("|");
  return terminalSessionRolesLoader.getOrLoad(cacheKey, async () => {
    const response = await requestJson<TerminalSessionRolesResponse>(
      "/api/terminals/session-roles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionIds: normalizedSessionIds }),
      },
    );
    return Array.isArray(response.sessions) ? response.sessions : [];
  });
}

export async function createTerminal(
  input: CreateTerminalRequest,
): Promise<TerminalSnapshotResponse> {
  return requestJson<TerminalSnapshotResponse>("/api/terminals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function persistTerminalMessageAction(
  terminalId: string,
  input: TerminalPersistMessageActionRequest,
): Promise<TerminalPersistMessageActionResponse> {
  return requestJson<TerminalPersistMessageActionResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/message-action`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function deleteTerminal(
  terminalId: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/terminals/${encodeURIComponent(terminalId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function sendTerminalInput(
  terminalId: string,
  input: TerminalInputRequest,
  clientId?: string,
): Promise<TerminalInputResponse> {
  const params = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return requestJson<TerminalInputResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/input${params}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function resizeTerminal(
  terminalId: string,
  input: TerminalResizeRequest,
  clientId?: string,
): Promise<TerminalCommandResponse> {
  const params = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return requestJson<TerminalCommandResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/resize${params}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function restartTerminal(
  terminalId: string,
  clientId?: string,
): Promise<TerminalSnapshotResponse> {
  const params = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return requestJson<TerminalSnapshotResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/restart${params}`,
    {
      method: "POST",
    },
  );
}

export async function claimTerminalWrite(
  terminalId: string,
  clientId: string,
): Promise<TerminalCommandResponse> {
  return requestJson<TerminalCommandResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/claim-write`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientId }),
    },
  );
}

export async function releaseTerminalWrite(
  terminalId: string,
  clientId: string,
): Promise<TerminalCommandResponse> {
  return requestJson<TerminalCommandResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/release-write`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ clientId }),
    },
  );
}

export function subscribeTerminalsStream(
  handlers: TerminalsStreamHandlers,
): () => void {
  return subscribeTransportTerminalsStream(handlers);
}

export async function getSessionFileTree(
  sessionId: string,
): Promise<SessionFileTreeResponse> {
  return requestJson<SessionFileTreeResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/file-tree`,
  );
}

export async function getSessionFileTreeNodes(
  sessionId: string,
  dir: string = "",
  cursor: number = 0,
  limit: number = 500,
): Promise<SessionFileTreeNodesResponse> {
  const params = new URLSearchParams({
    dir,
    cursor: String(Math.max(0, Math.floor(cursor))),
    limit: String(Math.max(1, Math.floor(limit))),
  });
  return requestJson<SessionFileTreeNodesResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/file-tree/nodes?${params.toString()}`,
  );
}

export async function getWorkflowProjectFileTreeNodes(
  workflowKey: string,
  dir: string = "",
  cursor: number = 0,
  limit: number = 500,
): Promise<SessionFileTreeNodesResponse> {
  const params = new URLSearchParams({
    dir,
    cursor: String(Math.max(0, Math.floor(cursor))),
    limit: String(Math.max(1, Math.floor(limit))),
  });
  return requestJson<SessionFileTreeNodesResponse>(
    `/api/workflow-project/${encodeURIComponent(workflowKey)}/file-tree/nodes?${params.toString()}`,
  );
}

export async function searchSessionFiles(
  sessionId: string,
  query: string,
  limit: number = 40,
): Promise<SessionFileSearchResponse> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
  });
  return requestJson<SessionFileSearchResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/file-search?${params.toString()}`,
  );
}

export async function getSessionFileContent(
  sessionId: string,
  path: string,
  page: number = 1,
): Promise<SessionFileContentResponse> {
  const params = new URLSearchParams({ path, page: String(page) });
  return requestJson<SessionFileContentResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/file-content?${params.toString()}`,
  );
}

export async function getWorkflowProjectFileContent(
  workflowKey: string,
  path: string,
  page: number = 1,
): Promise<SessionFileContentResponse> {
  const params = new URLSearchParams({ path, page: String(page) });
  return requestJson<SessionFileContentResponse>(
    `/api/workflow-project/${encodeURIComponent(workflowKey)}/file-content?${params.toString()}`,
  );
}

export async function getWorkflowProjectSkills(
  workflowKey: string,
): Promise<SessionSkillsResponse> {
  return requestJson<SessionSkillsResponse>(
    `/api/workflow-project/${encodeURIComponent(workflowKey)}/skills`,
  );
}

export async function setWorkflowProjectSkillEnabled(
  workflowKey: string,
  input: SessionSkillConfigWriteRequest,
): Promise<SessionSkillConfigWriteResponse> {
  return requestJson<SessionSkillConfigWriteResponse>(
    `/api/workflow-project/${encodeURIComponent(workflowKey)}/skills/config`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}
