import type { CodexBackgroundTerminal } from "@codex-deck/api";
import type { CodexOperationalNotification } from "@codex-deck/api";
import type { CodexHookRun } from "@codex-deck/api";
import type { CodexMemoryStatus, CodexThreadMemory } from "@codex-deck/api";
import type { CodexReviewTarget, CodexReviewResult } from "@codex-deck/api";
import type {
  DiffGuideStartRequest,
  DiffGuideStartResponse,
  DiffGuideContentResponse,
  DiffGuideSummary,
  DiffGuideSourceResponse,
  ConversationMessage,
  CodexCollaborationModeOption,
  CodexThreadStateResponse,
  CodexThreadSummary,
  CodexThreadGoalClearResponse,
  CodexThreadGoalGetResponse,
  CodexThreadGoalSetRequest,
  CodexThreadGoalSetResponse,
  CodexThreadNameSetRequest,
  CodexThreadNameSetResponse,
  CodexThreadForkResponse,
  CodexThreadSideStartResponse,
  CodexThreadCompactResponse,
  CodexThreadArchiveResponse,
  CodexMemoriesResetResponse,
  CodexMemoriesSettingsResponse,
  CodexMemoriesSettingsWriteRequest,
  CodexMemoriesSettingsWriteResponse,
  CodexPetSelectionRequest,
  CodexPetSelectionResponse,
  CodexPetsResponse,
  CodexThreadAgentListResponse,
  CodexThreadAgentActionRequest,
  CodexThreadAgentActionResponse,
  CodexThreadSummariesRequest,
  CodexThreadSummariesResponse,
  CodexModelOption,
  CodexAgentWaitConfig,
  CodexConfigDefaultsResponse,
  CodexDeckConfigFileResponse,
  CodexDeckConfigWriteRequest,
  CodexDeckConfigWriteResponse,
  CodexDeckUpdateRequest,
  CodexDeckUpdateOutputResponse,
  CodexDeckUpdateResponse,
  CodexDeckUpdateStatusResponse,
  CodexHomeDescriptor,
  CodexSessionContextResponse,
  DeleteTerminalResponse,
  DeleteWorkflowResponse,
  DeleteSessionOptions,
  DeleteSessionResponse,
  FixDanglingSessionResponse,
  EditConversationMessageResponse,
  SessionExistsResponse,
  SessionContentSearchResponse,
  SessionFileContentResponse,
  SessionFileSearchResponse,
  SessionFileTreeResponse,
  SessionFileTreeNodesResponse,
  SessionHooksConfigWriteRequest,
  SessionHooksConfigWriteResponse,
  SessionHooksResponse,
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
  TerminalChatActionRequest,
  TerminalChatActionResponse,
  TerminalResizeRequest,
  TerminalSnapshotResponse,
  SessionDiffMode,
  SessionDiffResponse,
  SessionTerminalRunOutputResponse,
  SessionTerminalRunsResponse,
  TranslateTextRequest,
  TranslateTextResponse,
  CreateCodexThreadRequest,
  CreateCodexThreadResponse,
  CodexUserInputRequest,
  CodexUserInputResponsePayload,
  CodexApprovalRequest,
  CodexApprovalResponsePayload,
  SendCodexMessageInputItem,
  SendCodexMessageRequest,
  SendCodexMessageResponse,
} from "@codex-deck/api";
import { getRemoteAuthHint } from "@zuoyehaoduoa/wire";
import type {
  RemoteMachineDescription,
  RemoteServerTrustPins,
} from "./remote-client";
export type { RemoteServerTrustPins };
export { subscribeCodexDeckUpdateOutput } from "./transport";
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
import { requestTranslation } from "./transport/translation";
import { requestLocalJson } from "./transport/shared";
import { addCodexHomeToApiUrl } from "./codex-home-scope";
import { getActiveCodexHomeId } from "./codex-home-scope";
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

interface CodexHomesResponse {
  homes: CodexHomeDescriptor[];
  mainHomeId: string;
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

export async function listCodexHomes(): Promise<CodexHomesResponse> {
  const response = await requestJson<CodexHomesResponse>("/api/codex-homes");
  return {
    homes: Array.isArray(response.homes) ? response.homes : [],
    mainHomeId:
      typeof response.mainHomeId === "string" && response.mainHomeId.trim()
        ? response.mainHomeId
        : "main",
  };
}

export async function getCodexDeckConfig(): Promise<CodexDeckConfigFileResponse> {
  return requestJson<CodexDeckConfigFileResponse>("/api/codex-deck/config");
}

export async function applyCodexDeckConfig(
  input: CodexDeckConfigWriteRequest,
): Promise<CodexDeckConfigWriteResponse> {
  return requestJson<CodexDeckConfigWriteResponse>("/api/codex-deck/config", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function getCodexDeckUpdateStatus(): Promise<CodexDeckUpdateStatusResponse> {
  return requestJson<CodexDeckUpdateStatusResponse>("/api/codex-deck/update");
}

export async function getCodexDeckUpdateOutput(): Promise<CodexDeckUpdateOutputResponse> {
  return requestJson<CodexDeckUpdateOutputResponse>(
    "/api/codex-deck/update/output",
  );
}

export async function checkCodexDeckNpmUpdate(): Promise<CodexDeckUpdateStatusResponse> {
  return requestJson<CodexDeckUpdateStatusResponse>(
    "/api/codex-deck/update/check",
    { method: "POST" },
  );
}

export async function updateCodexDeckDaemon(
  input: CodexDeckUpdateRequest,
): Promise<CodexDeckUpdateResponse> {
  return requestJson<CodexDeckUpdateResponse>("/api/codex-deck/update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

const READONLY_CLI_CACHE_TTL_MS = 30_000;
const THREAD_STATE_CACHE_TTL_MS = 250;
const SESSION_ROLE_CACHE_TTL_MS = 250;
const WORKFLOW_SESSION_LOOKUP_CACHE_TTL_MS = 250;

interface TimedCacheEntry<T> {
  value: T;
  expiresAt: number;
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

function homeScopedCacheKey(key: string): string {
  return `${getActiveCodexHomeId()}:${key}`;
}

function currentHomeThreadCachePrefix(threadId: string): string {
  return `${getActiveCodexHomeId()}:${threadId}:`;
}

const loadCodexModels = createKeyedTimedLoader<CodexModelOption[]>(
  READONLY_CLI_CACHE_TTL_MS,
);

const loadCodexCollaborationModes = createKeyedTimedLoader<
  CodexCollaborationModeOption[]
>(READONLY_CLI_CACHE_TTL_MS);

const loadCodexConfigDefaults =
  createKeyedTimedLoader<CodexConfigDefaultsResponse>(
    READONLY_CLI_CACHE_TTL_MS,
  );

const codexThreadStateLoader = createKeyedTimedLoader<CodexThreadStateResponse>(
  THREAD_STATE_CACHE_TTL_MS,
);
const workflowBySessionLoader =
  createKeyedTimedLoader<WorkflowSessionLookupResponse | null>(
    WORKFLOW_SESSION_LOOKUP_CACHE_TTL_MS,
  );
const workflowSessionRolesLoader = createKeyedTimedLoader<
  WorkflowSessionRoleSummary[]
>(SESSION_ROLE_CACHE_TTL_MS);
const terminalSessionRolesLoader = createKeyedTimedLoader<
  TerminalSessionRoleSummary[]
>(SESSION_ROLE_CACHE_TTL_MS);

function resetApiRequestCaches(): void {
  loadCodexModels.clearMatching(() => true);
  loadCodexCollaborationModes.clearMatching(() => true);
  loadCodexConfigDefaults.clearMatching(() => true);
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
  return workflowBySessionLoader.getOrLoad(
    homeScopedCacheKey(normalizedSessionId),
    async () => {
      const response = await requestJson<WorkflowSessionLookupResult>(
        `/api/workflows/by-session/${encodeURIComponent(normalizedSessionId)}`,
      );
      return response.match ?? null;
    },
  );
}

export async function getWorkflowSessionRoles(
  sessionIds: string[],
): Promise<WorkflowSessionRoleSummary[]> {
  const normalizedSessionIds = [...sessionIds]
    .map((sessionId) => sessionId.trim())
    .filter((sessionId) => sessionId.length > 0)
    .sort();
  const cacheKey = homeScopedCacheKey(normalizedSessionIds.join("|"));
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
  options?: { deleteSessions?: boolean },
): Promise<DeleteWorkflowResponse> {
  const query = options?.deleteSessions ? "?deleteSessions=true" : "";
  return requestJsonAndNotifyWorkflow<DeleteWorkflowResponse>(
    key,
    `/api/workflows/${encodeURIComponent(key)}${query}`,
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
  return loadCodexModels.getOrLoad(getActiveCodexHomeId(), async () => {
    const payload = await requestJson<CodexModelsResponse>("/api/codex/models");
    return Array.isArray(payload.models) ? payload.models : [];
  });
}

export async function fetchCodexModels(
  cwd?: string | null,
): Promise<CodexModelOption[]> {
  const payload = await requestJson<CodexModelsResponse>(
    "/api/codex/models/fetch",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cwd: cwd?.trim() || null }),
    },
  );
  return Array.isArray(payload.models) ? payload.models : [];
}

export async function listCodexCollaborationModes(): Promise<
  CodexCollaborationModeOption[]
> {
  return loadCodexCollaborationModes.getOrLoad(
    getActiveCodexHomeId(),
    async () => {
      const payload = await requestJson<CodexCollaborationModesResponse>(
        "/api/codex/collaboration-modes",
      );
      return Array.isArray(payload.modes) ? payload.modes : [];
    },
  );
}

export async function getCodexConfigDefaults(): Promise<CodexConfigDefaultsResponse> {
  return loadCodexConfigDefaults.getOrLoad(getActiveCodexHomeId(), () =>
    requestJson<CodexConfigDefaultsResponse>("/api/codex/defaults"),
  );
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
    key.startsWith(currentHomeThreadCachePrefix(normalizedThreadId)),
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
  options?: {
    includeStatusDetails?: boolean;
  },
): Promise<CodexThreadStateResponse> {
  const normalizedThreadId = threadId.trim();
  const params = new URLSearchParams();
  if (typeof turnId === "string" && turnId.trim()) {
    params.set("turnId", turnId.trim());
  }
  if (options?.includeStatusDetails) {
    params.set("includeStatusDetails", "true");
  }
  const query = params.toString();
  const cacheKey = [
    getActiveCodexHomeId(),
    normalizedThreadId,
    params.get("turnId") ?? "",
    options?.includeStatusDetails ? "status" : "",
  ].join(":");
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
    key.startsWith(currentHomeThreadCachePrefix(normalizedThreadId)),
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

export function startDiffGuide(
  input: DiffGuideStartRequest,
): Promise<DiffGuideStartResponse> {
  return requestJson("/api/diff-guides/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function retryDiffGuide(
  sessionId: string,
): Promise<DiffGuideStartResponse> {
  return requestJson(
    `/api/diff-guides/${encodeURIComponent(sessionId)}/retry`,
    { method: "POST" },
  );
}

export function getDiffGuides(): Promise<DiffGuideSummary[]> {
  return requestJson("/api/diff-guides");
}

export function getDiffGuide(
  sessionId: string,
): Promise<DiffGuideContentResponse> {
  return requestJson(`/api/diff-guides/${encodeURIComponent(sessionId)}`);
}

export function getDiffGuideSource(
  sessionId: string,
  input: {
    path: string;
    side: "left" | "right";
    start: number;
    limit: number;
  },
): Promise<DiffGuideSourceResponse> {
  const query = new URLSearchParams({
    path: input.path,
    side: input.side,
    start: String(input.start),
    limit: String(input.limit),
  });
  return requestJson(
    `/api/diff-guides/${encodeURIComponent(sessionId)}/source?${query}`,
  );
}

export async function startCodexSideThread(
  threadId: string,
): Promise<CodexThreadSideStartResponse> {
  return requestJson<CodexThreadSideStartResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/side`,
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

export async function archiveCodexThread(
  threadId: string,
): Promise<CodexThreadArchiveResponse> {
  return requestJson<CodexThreadArchiveResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/archive`,
    {
      method: "POST",
    },
  );
}

export async function getCodexMemoriesSettings(
  cwd?: string | null,
): Promise<CodexMemoriesSettingsResponse> {
  const params = new URLSearchParams();
  if (typeof cwd === "string" && cwd.trim()) {
    params.set("cwd", cwd.trim());
  }
  const query = params.toString();
  return requestJson<CodexMemoriesSettingsResponse>(
    `/api/codex/memories${query ? `?${query}` : ""}`,
  );
}

export async function writeCodexMemoriesSettings(
  input: CodexMemoriesSettingsWriteRequest,
): Promise<CodexMemoriesSettingsWriteResponse> {
  return requestJson<CodexMemoriesSettingsWriteResponse>(
    "/api/codex/memories",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function resetCodexMemories(): Promise<CodexMemoriesResetResponse> {
  return requestJson<CodexMemoriesResetResponse>("/api/codex/memories/reset", {
    method: "POST",
  });
}

export async function getCodexPets(): Promise<CodexPetsResponse> {
  return requestJson<CodexPetsResponse>("/api/codex/pets");
}

export async function selectCodexPet(
  input: CodexPetSelectionRequest,
): Promise<CodexPetSelectionResponse> {
  return requestJson<CodexPetSelectionResponse>("/api/codex/pets", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function getCodexThreadGoal(
  threadId: string,
): Promise<CodexThreadGoalGetResponse> {
  return requestJson<CodexThreadGoalGetResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/goal`,
  );
}

export async function setCodexThreadGoal(
  threadId: string,
  input: CodexThreadGoalSetRequest,
): Promise<CodexThreadGoalSetResponse> {
  return requestJsonAndNotifyConversation<CodexThreadGoalSetResponse>(
    threadId,
    `/api/codex/threads/${encodeURIComponent(threadId)}/goal`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function clearCodexThreadGoal(
  threadId: string,
): Promise<CodexThreadGoalClearResponse> {
  return requestJsonAndNotifyConversation<CodexThreadGoalClearResponse>(
    threadId,
    `/api/codex/threads/${encodeURIComponent(threadId)}/goal`,
    {
      method: "DELETE",
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

export async function getCodexAgentWaitConfig(
  threadId: string,
): Promise<CodexAgentWaitConfig> {
  const normalizedThreadId = threadId.trim();
  return requestJson<CodexAgentWaitConfig>(
    `/api/codex/threads/${encodeURIComponent(normalizedThreadId)}/agent-wait-config`,
  );
}

export async function sendCodexAgentAction(
  controllerThreadId: string,
  input: CodexThreadAgentActionRequest,
): Promise<CodexThreadAgentActionResponse> {
  const normalizedThreadId = controllerThreadId.trim();
  codexThreadStateLoader.clearMatching((key) =>
    key.startsWith(currentHomeThreadCachePrefix(normalizedThreadId)),
  );
  return requestJsonAndNotifyConversation<CodexThreadAgentActionResponse>(
    normalizedThreadId,
    `/api/codex/threads/${encodeURIComponent(normalizedThreadId)}/agent-actions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
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

export async function listCodexElicitations(
  threadId: string,
): Promise<import("@codex-deck/api").CodexElicitationRequest[]> {
  const payload = await requestJson<{
    requests: import("@codex-deck/api").CodexElicitationRequest[];
  }>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/requests/elicitations`,
  );
  return payload.requests;
}

export async function respondCodexElicitation(
  threadId: string,
  requestId: string,
  response: import("@codex-deck/api").CodexElicitationResponse,
): Promise<{ ok: boolean }> {
  return requestJsonAndNotifyConversation(
    threadId,
    `/api/codex/threads/${encodeURIComponent(threadId)}/requests/elicitations/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    },
  );
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

export async function searchSessionContent(
  query: string,
): Promise<SessionContentSearchResponse> {
  const params = new URLSearchParams({ query });
  return requestJson<SessionContentSearchResponse>(
    `/api/sessions/search?${params.toString()}`,
  );
}

export async function deleteSession(
  sessionId: string,
  clientId?: string,
  options: DeleteSessionOptions = {},
): Promise<DeleteSessionResponse> {
  const params = new URLSearchParams();
  if (clientId) params.set("clientId", clientId);
  if (options.deleteDiffGuide !== undefined) {
    params.set("deleteDiffGuide", String(options.deleteDiffGuide));
  }
  const query = params.size ? `?${params.toString()}` : "";
  return requestJson<DeleteSessionResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}${query}`,
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

export async function translateText(
  request: TranslateTextRequest,
  onProgress?: (text: string) => void,
): Promise<TranslateTextResponse> {
  const remote = remoteClient.isConnected();
  const homeId = getActiveCodexHomeId();
  return requestTranslation(request, {
    requestJson: <T>(url: string, init?: RequestInit) => {
      if (getActiveCodexHomeId() !== homeId)
        return Promise.reject(
          new Error("Selected Codex home changed during translation."),
        );
      return remote
        ? remoteClient.requestJson<T>(addCodexHomeToApiUrl(url, homeId), init)
        : requestLocalJson<T>(addCodexHomeToApiUrl(url, homeId), init);
    },
    createEventSource: remote
      ? undefined
      : (url) => new EventSource(addCodexHomeToApiUrl(url, homeId)),
    onProgress,
  });
}

export async function editConversationMessage(
  sessionId: string,
  editId: string,
  expectedText: string,
  text: string,
): Promise<EditConversationMessageResponse> {
  return requestJsonAndNotifyConversation<EditConversationMessageResponse>(
    sessionId,
    `/api/conversation/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(editId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expectedText, text }),
    },
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

export async function getSessionHooks(
  sessionId: string,
): Promise<SessionHooksResponse> {
  return requestJson<SessionHooksResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/hooks`,
  );
}

export async function setSessionHookState(
  sessionId: string,
  input: SessionHooksConfigWriteRequest,
): Promise<SessionHooksConfigWriteResponse> {
  return requestJson<SessionHooksConfigWriteResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/hooks/config`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
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
  const cacheKey = homeScopedCacheKey(normalizedSessionIds.join("|"));
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

export async function sendTerminalChatAction(
  terminalId: string,
  input: TerminalChatActionRequest,
): Promise<TerminalChatActionResponse> {
  return requestJson<TerminalChatActionResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/chat-action`,
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
  options?: { deleteBoundSession?: boolean },
): Promise<DeleteTerminalResponse> {
  const query = options?.deleteBoundSession ? "?deleteBoundSession=true" : "";
  return requestJson<DeleteTerminalResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}${query}`,
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
  source: "restart" | "activate" = "restart",
): Promise<TerminalSnapshotResponse> {
  const params = new URLSearchParams();
  if (clientId) {
    params.set("clientId", clientId);
  }
  if (source !== "restart") {
    params.set("source", source);
  }
  return requestJson<TerminalSnapshotResponse>(
    `/api/terminals/${encodeURIComponent(terminalId)}/restart${
      params.size > 0 ? `?${params.toString()}` : ""
    }`,
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

export async function getGeneratedImage(
  sessionId: string,
  itemId: string,
): Promise<{ dataUrl: string }> {
  return requestJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/generated-image/${encodeURIComponent(itemId)}`,
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

export async function getWorkflowProjectHooks(
  workflowKey: string,
): Promise<SessionHooksResponse> {
  return requestJson<SessionHooksResponse>(
    `/api/workflow-project/${encodeURIComponent(workflowKey)}/hooks`,
  );
}

export async function setWorkflowProjectHookState(
  workflowKey: string,
  input: SessionHooksConfigWriteRequest,
): Promise<SessionHooksConfigWriteResponse> {
  return requestJson<SessionHooksConfigWriteResponse>(
    `/api/workflow-project/${encodeURIComponent(workflowKey)}/hooks/config`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
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

export async function startCodexReview(
  threadId: string,
  target: CodexReviewTarget,
): Promise<CodexReviewResult> {
  codexThreadStateLoader.clearMatching((key) =>
    key.startsWith(currentHomeThreadCachePrefix(threadId)),
  );
  return requestJsonAndNotifyConversation<CodexReviewResult>(
    threadId,
    `/api/codex/threads/${encodeURIComponent(threadId)}/review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    },
  );
}

export function getCodexMemoryStatus(): Promise<CodexMemoryStatus> {
  return requestJson("/api/codex/memories/status");
}
export function getCodexThreadMemory(
  threadId: string,
): Promise<CodexThreadMemory> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/memory`,
  );
}

export function getCodexHookRuns(
  threadId: string,
): Promise<{ runs: CodexHookRun[] }> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/hook-runs`,
  );
}

export function getCodexOperationalNotifications(
  threadId?: string | null,
): Promise<{ notifications: CodexOperationalNotification[] }> {
  return requestJson(
    `/api/codex/notifications${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
  );
}

export function getCodexBackgroundTerminals(
  threadId: string,
): Promise<{ terminals: CodexBackgroundTerminal[] }> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/background-terminals`,
  );
}
export function terminateCodexBackgroundTerminal(
  threadId: string,
  processId: string,
): Promise<{ terminated: boolean }> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/background-terminals/${encodeURIComponent(processId)}/terminate`,
    { method: "POST" },
  );
}

type CodexQueuedMessage = import("@codex-deck/api").CodexQueuedMessage;
function threadQueueUrl(threadId: string, suffix = ""): string {
  return `/api/codex/threads/${encodeURIComponent(threadId.trim())}/queue${suffix}`;
}
export function getCodexThreadQueue(
  threadId: string,
): Promise<import("@codex-deck/api").CodexThreadQueueSnapshot> {
  return requestJson(threadQueueUrl(threadId));
}
/** `supported: false` means the app-server has no shared queue. */
export function addCodexThreadQueueMessage(
  threadId: string,
  input: SendCodexMessageInputItem[],
  clientUserMessageId?: string,
): Promise<{ supported: boolean; item?: CodexQueuedMessage }> {
  return requestJson(threadQueueUrl(threadId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, clientUserMessageId }),
  });
}
export function updateCodexThreadQueueMessage(
  threadId: string,
  itemId: string,
  text: string,
): Promise<{ item: CodexQueuedMessage }> {
  return requestJson(
    threadQueueUrl(threadId, `/${encodeURIComponent(itemId)}`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
}
export function deleteCodexThreadQueueMessage(
  threadId: string,
  itemId: string,
): Promise<{ deleted: boolean }> {
  return requestJson(
    threadQueueUrl(threadId, `/${encodeURIComponent(itemId)}`),
    {
      method: "DELETE",
    },
  );
}
export function reorderCodexThreadQueue(
  threadId: string,
  ids: string[],
): Promise<{ ok: boolean }> {
  return requestJson(threadQueueUrl(threadId, "/reorder"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}
export function moveCodexThreadQueueMessage(
  threadId: string,
  itemId: string,
  direction: "up" | "down",
): Promise<{ moved: boolean }> {
  return requestJson(
    threadQueueUrl(threadId, `/${encodeURIComponent(itemId)}/move`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    },
  );
}
export function startCodexThreadQueueMessage(
  threadId: string,
  itemId: string,
): Promise<{ ok: boolean; turnId: string | null }> {
  return requestJsonAndNotifyConversation(
    threadId.trim(),
    threadQueueUrl(threadId, `/${encodeURIComponent(itemId)}/start`),
    { method: "POST" },
  );
}

export function getCodexMcpInventory(
  threadId: string | null,
): Promise<import("@codex-deck/api").McpInventorySnapshot> {
  return requestJson(
    `/api/codex/mcp${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
  );
}
export function loginCodexMcpServer(
  name: string,
  threadId: string | null,
): Promise<{ authorizationUrl: string; loginId?: string }> {
  return requestJson("/api/codex/mcp/login", {
    method: "POST",
    body: JSON.stringify({ name, threadId }),
  });
}
export function reloadCodexMcpServers(): Promise<{ ok: boolean }> {
  return requestJson("/api/codex/mcp/reload", { method: "POST" });
}

export function readCodexMcpAppResource(input: {
  threadId: string;
  callId: string;
}): Promise<import("@codex-deck/api").CodexMcpAppResourceResponse> {
  return requestJson("/api/codex/mcp-apps/resource", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function callCodexMcpAppTool(input: {
  threadId: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}): Promise<import("@codex-deck/api").CodexMcpAppToolCallResponse> {
  return requestJson("/api/codex/mcp-apps/tool-call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getCodexIdeContextStatus(input: {
  threadId?: string | null;
  cwd?: string | null;
}): Promise<import("@codex-deck/api").CodexIdeContextStatus> {
  const params = new URLSearchParams();
  if (input.threadId) params.set("threadId", input.threadId);
  if (input.cwd) params.set("cwd", input.cwd);
  const query = params.toString();
  return requestJson(`/api/codex/ide-context${query ? `?${query}` : ""}`);
}

export function getCodexUsageDashboard(
  threadId: string | null,
): Promise<import("@codex-deck/api").UsageDashboardSnapshot> {
  return requestJson(
    `/api/codex/usage${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
  );
}
export function consumeCodexResetCredit(
  idempotencyKey: string,
  creditId: string | null,
): Promise<{ outcome: string }> {
  return requestJson("/api/codex/usage/reset-credit", {
    method: "POST",
    body: JSON.stringify({ idempotencyKey, creditId }),
  });
}

export function getCodexRecap(
  threadId: string,
): Promise<{ recap: import("@codex-deck/api").ConversationRecap | null }> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/recap`,
  );
}
export function startCodexRecap(
  threadId: string,
): Promise<{ recap: import("@codex-deck/api").ConversationRecap }> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/recap`,
    { method: "POST" },
  );
}

export function getCodexExperimentalFeatures(
  threadId: string | null,
): Promise<{ features: import("@codex-deck/api").ExperimentalFeature[] }> {
  return requestJson(
    `/api/codex/experimental${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
  );
}
export function setCodexExperimentalFeatures(
  threadId: string | null,
  updates: Record<string, boolean>,
): Promise<import("@codex-deck/api").ExperimentalWriteResult> {
  return requestJson("/api/codex/experimental", {
    method: "POST",
    body: JSON.stringify({ threadId, updates }),
  });
}

export function getCodexDaybreak(
  threadId: string,
  model: string | null,
): Promise<import("@codex-deck/api").DaybreakState> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/daybreak${model ? `?model=${encodeURIComponent(model)}` : ""}`,
  );
}
export function setCodexDaybreak(
  threadId: string,
  enabled: boolean,
  model: string | null,
): Promise<import("@codex-deck/api").DaybreakState> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/daybreak`,
    { method: "POST", body: JSON.stringify({ enabled, model }) },
  );
}

export function getCodexWarnings(
  threadId: string | null,
): Promise<{ warnings: CodexOperationalNotification[] }> {
  return requestJson(
    `/api/codex/warnings${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
  );
}
export function getCodexConfigDiagnostics(
  threadId: string | null,
): Promise<import("@codex-deck/api").ConfigDiagnostics> {
  return requestJson(
    `/api/codex/debug-config${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
  );
}

export function changeCodexWorkingDirectory(
  threadId: string,
  path: string,
  currentCwd: string | null,
): Promise<import("@codex-deck/api").WorkingDirectoryChangeResult> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/working-directory`,
    { method: "POST", body: JSON.stringify({ path, currentCwd }) },
  );
}

export function getCodexPermissions(
  threadId: string,
): Promise<import("@codex-deck/api").CodexPermissionSnapshot> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/permissions`,
  );
}
export function setCodexPermissions(
  threadId: string,
  selection: import("@codex-deck/api").CodexPermissionSelection,
): Promise<import("@codex-deck/api").CodexPermissionSnapshot> {
  return requestJson(
    `/api/codex/threads/${encodeURIComponent(threadId)}/permissions`,
    { method: "POST", body: JSON.stringify(selection) },
  );
}
