import { io, type Socket } from "socket.io-client";
import {
  decryptRemotePayload,
  deriveRemoteLoginHandle,
  deriveRemoteRelayKeyFromExportKey,
  encryptRemotePayload,
  finishRemoteOpaqueLogin,
  getRemoteAuthHint,
  RemoteAuthErrorCode,
  startRemoteOpaqueLogin,
  type RemoteMachineMetadata,
  type RemoteMachineState,
  verifyRemoteRpcResultSignature,
} from "@codex-deck/wire";

interface BootstrapResponse {
  remoteAuthVersion: 2;
  realmId: string;
  opaqueServerPublicKey: string;
  browserPersistence: "session" | "remember";
}

interface OpaqueLoginStartResponse {
  loginId: string;
  loginResponse: string;
}

interface OpaqueLoginFinishResponse {
  success: boolean;
  token: string;
}

interface MachineApiItem {
  id: string;
  metadata: string;
  daemonState: string | null;
  active: boolean;
  activeAt: number;
}

export interface RemoteServerTrustPins {
  realmId?: string | null;
  opaqueServerPublicKey?: string | null;
}

interface RemoteHttpProxyRequest {
  method: string;
  path: string;
  body?: unknown;
}

interface RemoteHttpProxyResponse {
  status: number;
  body: unknown;
}

interface RemoteRpcRequestEnvelope {
  requestId: string;
  body: unknown;
}

interface RemoteRpcResultEnvelope {
  ok: boolean;
  requestId: string;
  body?: unknown;
  error?: string;
}

interface RemoteRouteResponse {
  ok: boolean;
  result?: string;
  signature?: string;
  signerPublicKey?: string;
  signatureVersion?: number;
  error?: string;
}

interface StoredRemoteAuthState {
  loginHandle: string;
  exportKey: string;
  realmId: string;
  pinnedOpaqueServerPublicKey: string;
  machineSigningPublicKeys: Record<string, string>;
  selectedMachineId: string | null;
}

type StorageBackend = "session" | "local";

export interface RemoteMachineDescription {
  id: string;
  metadata: RemoteMachineMetadata | null;
  state: RemoteMachineState | null;
  active: boolean;
  activeAt: number;
}

type RemoteClientListener = () => void;

const REMOTE_STORAGE_PREFIX = "codex-deck:remote:";
const REMOTE_LATENCY_LOG_STORAGE_KEY = "codex-deck:remote-latency-log:v1";
const REMOTE_LATENCY_LOG_QUERY_PARAM = "remoteLatencyLog";

function parseOptionalBoolean(raw: string | null): boolean | null {
  if (typeof raw !== "string") {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return null;
}

function monotonicNow(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

function resolveInitialRemoteLatencyLoggingEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const queryValue = parseOptionalBoolean(
    new URLSearchParams(window.location.search).get(
      REMOTE_LATENCY_LOG_QUERY_PARAM,
    ),
  );
  if (queryValue !== null) {
    window.localStorage.setItem(
      REMOTE_LATENCY_LOG_STORAGE_KEY,
      queryValue ? "1" : "0",
    );
    return queryValue;
  }

  const storedValue = parseOptionalBoolean(
    window.localStorage.getItem(REMOTE_LATENCY_LOG_STORAGE_KEY),
  );
  return storedValue ?? false;
}

function createRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toWebSocketUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/i, (match) =>
    match.toLowerCase() === "https" ? "wss" : "ws",
  );
}

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 15_000;

function formatNonJsonResponseError(
  response: Response,
  text: string,
  source: string,
): string {
  const contentType = response.headers.get("content-type") || "unknown";
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (contentType.includes("text/html")) {
    return `${source} returned an HTML error page (${response.status}). The remote tunnel or proxy may be unstable.`;
  }
  return `${source} returned a non-JSON response (${response.status}, ${contentType})${trimmed ? `: ${trimmed.slice(0, 200)}` : ""}`;
}

function isTransientRemoteError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("socket has been disconnected") ||
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("html error page (502)") ||
    message.includes("html error page (503)") ||
    message.includes("html error page (504)") ||
    message.includes("status 502") ||
    message.includes("status 503") ||
    message.includes("status 504")
  );
}

function getRemoteErrorStatusCode(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const cause =
    "cause" in error &&
    error.cause &&
    typeof error.cause === "object" &&
    !Array.isArray(error.cause)
      ? (error.cause as { status?: unknown })
      : null;
  return typeof cause?.status === "number" ? cause.status : null;
}

function isRemoteAuthenticationError(error: unknown): boolean {
  const status = getRemoteErrorStatusCode(error);
  if (status === 401 || status === 403) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("invalid token") ||
    message.includes("invalid authentication token") ||
    message.includes("missing authorization header") ||
    message.includes("authentication failed")
  );
}

async function withRemoteRetry<T>(
  operation: () => Promise<T>,
  options: { retries: number; retryDelayMs: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= options.retries || !isTransientRemoteError(error)) {
        throw error;
      }
      await new Promise((resolve) => {
        window.setTimeout(resolve, options.retryDelayMs);
      });
    }
  }
  throw lastError;
}

function createTimedAbortSignal(
  upstreamSignal: AbortSignal | null | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;

  const abortWithReason = (reason?: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  const handleUpstreamAbort = () => {
    abortWithReason(upstreamSignal?.reason);
  };

  if (upstreamSignal?.aborted) {
    handleUpstreamAbort();
  } else if (upstreamSignal) {
    upstreamSignal.addEventListener("abort", handleUpstreamAbort, {
      once: true,
    });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    abortWithReason(new Error("Remote request timed out"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      if (upstreamSignal) {
        upstreamSignal.removeEventListener("abort", handleUpstreamAbort);
      }
    },
  };
}

async function requestJson<T>(
  url: URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const timedSignal = createTimedAbortSignal(init?.signal, timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      credentials: "include",
      ...init,
      signal: timedSignal.signal,
    });
  } catch (error) {
    timedSignal.cleanup();
    if (timedSignal.didTimeout()) {
      throw new Error(`Remote request timed out after ${timeoutMs}ms`);
    }
    throw error;
  }

  try {
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
            ? formatNonJsonResponseError(
                response,
                (payload as { text: string }).text,
                "Remote request",
              )
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
        formatNonJsonResponseError(
          response,
          String((payload as { text: string }).text),
          "Remote endpoint",
        ),
      );
    }

    return payload as T;
  } finally {
    timedSignal.cleanup();
  }
}

function getStorageKey(serverUrl: string): string {
  return `${REMOTE_STORAGE_PREFIX}${encodeURIComponent(serverUrl)}`;
}

function readStoredStateFrom(
  storage: Storage | undefined,
  serverUrl: string,
): StoredRemoteAuthState | null {
  if (!storage) {
    return null;
  }

  const raw = storage.getItem(getStorageKey(serverUrl));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredRemoteAuthState>;
    if (
      typeof parsed.loginHandle !== "string" ||
      !parsed.loginHandle ||
      typeof parsed.exportKey !== "string" ||
      !parsed.exportKey ||
      typeof parsed.realmId !== "string" ||
      !parsed.realmId ||
      typeof parsed.pinnedOpaqueServerPublicKey !== "string" ||
      !parsed.pinnedOpaqueServerPublicKey
    ) {
      return null;
    }
    const machineSigningPublicKeys: Record<string, string> = {};
    if (
      parsed.machineSigningPublicKeys &&
      typeof parsed.machineSigningPublicKeys === "object" &&
      !Array.isArray(parsed.machineSigningPublicKeys)
    ) {
      for (const [machineId, publicKey] of Object.entries(
        parsed.machineSigningPublicKeys,
      )) {
        if (
          typeof machineId === "string" &&
          machineId.trim().length > 0 &&
          typeof publicKey === "string" &&
          publicKey.trim().length > 0
        ) {
          machineSigningPublicKeys[machineId] = publicKey;
        }
      }
    }
    return {
      loginHandle: parsed.loginHandle,
      exportKey: parsed.exportKey,
      realmId: parsed.realmId,
      pinnedOpaqueServerPublicKey: parsed.pinnedOpaqueServerPublicKey,
      machineSigningPublicKeys,
      selectedMachineId:
        typeof parsed.selectedMachineId === "string"
          ? parsed.selectedMachineId
          : null,
    };
  } catch {
    return null;
  }
}

function loadStoredState(
  serverUrl: string,
): { backend: StorageBackend; state: StoredRemoteAuthState } | null {
  if (typeof window === "undefined") {
    return null;
  }

  const sessionState = readStoredStateFrom(window.sessionStorage, serverUrl);
  if (sessionState) {
    return {
      backend: "session",
      state: sessionState,
    };
  }

  const localState = readStoredStateFrom(window.localStorage, serverUrl);
  if (localState) {
    return {
      backend: "local",
      state: localState,
    };
  }

  return null;
}

function clearStoredState(serverUrl: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const key = getStorageKey(serverUrl);
  window.sessionStorage.removeItem(key);
  window.localStorage.removeItem(key);
}

function saveStoredState(
  serverUrl: string,
  state: StoredRemoteAuthState | null,
  backend: StorageBackend,
): void {
  if (typeof window === "undefined") {
    return;
  }

  clearStoredState(serverUrl);
  if (!state) {
    return;
  }

  const targetStorage =
    backend === "local" ? window.localStorage : window.sessionStorage;
  targetStorage.setItem(getStorageKey(serverUrl), JSON.stringify(state));
}

export class RemoteClient {
  private socket: Socket | null = null;
  private token: string | null = null;
  private loginHandle: string | null = null;
  private exportKey: string | null = null;
  private relayKey: Uint8Array | null = null;
  private realmId: string | null = null;
  private pinnedOpaqueServerPublicKey: string | null = null;
  private machineSigningPublicKeys: Record<string, string> = {};
  private browserPersistence: StorageBackend = "session";
  private serverUrl: string | null = null;
  private machines: RemoteMachineDescription[] = [];
  private selectedMachineId: string | null = null;
  private remoteLatencyLoggingEnabled =
    resolveInitialRemoteLatencyLoggingEnabled();
  private readonly listeners = new Set<RemoteClientListener>();

  public hasSavedLogin(serverUrl: string): boolean {
    const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, "");
    return !!loadStoredState(normalizedServerUrl);
  }

  private normalizePins(pins?: RemoteServerTrustPins | null): {
    realmId: string | null;
    opaqueServerPublicKey: string | null;
  } {
    const realmId = pins?.realmId?.trim() || null;
    const opaqueServerPublicKey = pins?.opaqueServerPublicKey?.trim() || null;
    return {
      realmId: realmId && realmId.length > 0 ? realmId : null,
      opaqueServerPublicKey:
        opaqueServerPublicKey && opaqueServerPublicKey.length > 0
          ? opaqueServerPublicKey
          : null,
    };
  }

  public async login(
    serverUrl: string,
    username: string,
    password: string,
    pins?: RemoteServerTrustPins,
  ): Promise<RemoteMachineDescription[]> {
    const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, "");
    const normalizedPins = this.normalizePins(pins);
    const bootstrap = await this.fetchBootstrap(
      normalizedServerUrl,
      normalizedPins,
    );
    await this.resetRuntime();
    this.serverUrl = normalizedServerUrl;
    this.realmId = normalizedPins.realmId || bootstrap.realmId;
    this.pinnedOpaqueServerPublicKey =
      normalizedPins.opaqueServerPublicKey || bootstrap.opaqueServerPublicKey;
    this.browserPersistence =
      bootstrap.browserPersistence === "remember" ? "local" : "session";
    const loginHandle = await deriveRemoteLoginHandle(username, this.realmId);
    const authResult = await this.authenticateBrowser(
      password,
      loginHandle,
      bootstrap,
      bootstrap.browserPersistence === "remember",
    );
    this.loginHandle = loginHandle;
    this.exportKey = authResult.exportKey;
    this.relayKey = authResult.relayKey;
    this.token = authResult.token;
    this.machineSigningPublicKeys = {};
    await this.connectSocket();
    await this.refreshMachines();
    this.persistState();
    this.emitChange();
    return this.machines;
  }

  public async restoreSavedLogin(
    serverUrl: string,
    pins?: RemoteServerTrustPins,
  ): Promise<RemoteMachineDescription[] | null> {
    const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, "");
    const stored = loadStoredState(normalizedServerUrl);
    if (!stored) {
      return null;
    }

    const normalizedPins = this.normalizePins(pins);
    const effectivePins = {
      realmId: normalizedPins.realmId || stored.state.realmId,
      opaqueServerPublicKey:
        normalizedPins.opaqueServerPublicKey ||
        stored.state.pinnedOpaqueServerPublicKey,
    };
    const bootstrap = await this.fetchBootstrap(
      normalizedServerUrl,
      effectivePins,
    );
    if (bootstrap.realmId !== stored.state.realmId) {
      clearStoredState(normalizedServerUrl);
      throw new Error("Remote auth realm changed. Log in again.");
    }
    const sessionState = await requestJson<{ authenticated: boolean }>(
      new URL("/v1/auth/session", normalizedServerUrl),
    );
    if (!sessionState.authenticated) {
      return null;
    }

    await this.resetRuntime();
    this.serverUrl = normalizedServerUrl;
    this.realmId = stored.state.realmId;
    this.pinnedOpaqueServerPublicKey = stored.state.pinnedOpaqueServerPublicKey;
    this.browserPersistence = stored.backend;
    this.loginHandle = stored.state.loginHandle;
    this.exportKey = stored.state.exportKey;
    this.relayKey = await deriveRemoteRelayKeyFromExportKey(
      stored.state.exportKey,
    );
    this.selectedMachineId = stored.state.selectedMachineId;
    this.machineSigningPublicKeys = {
      ...stored.state.machineSigningPublicKeys,
    };
    this.token = null;
    await this.connectSocket();
    await this.refreshMachines();
    this.persistState();
    this.emitChange();
    return this.machines;
  }

  public async disconnect(): Promise<void> {
    if (this.serverUrl) {
      try {
        await requestJson<{ success: boolean }>(
          new URL("/v1/auth/logout", this.serverUrl),
          {
            method: "POST",
            headers: this.buildAuthHeaders(),
          },
        );
      } catch {
        // Ignore logout failures; local state still needs clearing.
      }
      clearStoredState(this.serverUrl);
    }
    await this.resetRuntime();
    this.emitChange();
  }

  public isAuthenticated(): boolean {
    return !!this.serverUrl && !!this.relayKey;
  }

  public isConnected(): boolean {
    return !!this.serverUrl && !!this.selectedMachineId && !!this.relayKey;
  }

  public getMachines(): RemoteMachineDescription[] {
    return this.machines;
  }

  public getSelectedMachineId(): string | null {
    return this.selectedMachineId;
  }

  public setSelectedMachineId(machineId: string | null): void {
    this.selectedMachineId = machineId;
    this.persistState();
    this.emitChange();
  }

  public subscribe(listener: RemoteClientListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public isLatencyLoggingEnabled(): boolean {
    return this.remoteLatencyLoggingEnabled;
  }

  public setLatencyLoggingEnabled(enabled: boolean): void {
    this.remoteLatencyLoggingEnabled = enabled;
    if (typeof window !== "undefined") {
      if (enabled) {
        window.localStorage.setItem(REMOTE_LATENCY_LOG_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(REMOTE_LATENCY_LOG_STORAGE_KEY);
      }
    }
    this.emitChange();
  }

  public async refreshMachines(): Promise<RemoteMachineDescription[]> {
    const serverUrl = this.serverUrl;
    const relayKey = this.relayKey;
    if (!serverUrl || !relayKey) {
      throw new Error("Remote client is not authenticated");
    }

    let machines: MachineApiItem[];
    try {
      machines = await requestJson<MachineApiItem[]>(
        new URL("/v1/machines", serverUrl),
        {
          headers: this.buildAuthHeaders(),
        },
      );
    } catch (error) {
      this.invalidateRemoteAuthStateOnFailure(error);
      throw error;
    }

    const resolvedMachines = await Promise.all(
      machines.map(async (machine) => ({
        id: machine.id,
        metadata: await decryptRemotePayload<RemoteMachineMetadata>(
          relayKey,
          machine.metadata,
        ),
        state: machine.daemonState
          ? await decryptRemotePayload<RemoteMachineState>(
              relayKey,
              machine.daemonState,
            )
          : null,
        active: machine.active,
        activeAt: machine.activeAt,
      })),
    );

    const nextMachineSigningPublicKeys = { ...this.machineSigningPublicKeys };
    for (const machine of resolvedMachines) {
      const machineSigningPublicKey =
        machine.metadata?.rpcSigningPublicKey?.trim();
      if (!machineSigningPublicKey) {
        throw new Error(
          `Remote machine ${machine.id} is missing an RPC signing key. Update the CLI to a version that supports signed remote responses.`,
        );
      }
      const pinned = nextMachineSigningPublicKeys[machine.id];
      if (pinned && pinned !== machineSigningPublicKey) {
        throw new Error(
          `Pinned CLI identity mismatch for machine ${machine.id}. Expected ${pinned}, got ${machineSigningPublicKey}.`,
        );
      }
      nextMachineSigningPublicKeys[machine.id] = machineSigningPublicKey;
    }
    for (const pinnedMachineId of Object.keys(nextMachineSigningPublicKeys)) {
      if (!resolvedMachines.some((machine) => machine.id === pinnedMachineId)) {
        delete nextMachineSigningPublicKeys[pinnedMachineId];
      }
    }

    this.machineSigningPublicKeys = nextMachineSigningPublicKeys;
    this.machines = resolvedMachines;

    if (
      this.selectedMachineId &&
      !this.machines.some((machine) => machine.id === this.selectedMachineId)
    ) {
      this.selectedMachineId = null;
    }

    if (!this.selectedMachineId) {
      this.selectedMachineId = this.machines[0]?.id ?? null;
    }

    this.persistState();
    this.emitChange();
    return this.machines;
  }

  public async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method || "GET";
    const requestTimeoutMs = path.includes("waitMs=") ? 35_000 : 15_000;
    const executeRequest = () =>
      this.callRemote<RemoteHttpProxyResponse>(
        "http",
        {
          method,
          path,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        } satisfies RemoteHttpProxyRequest,
        requestTimeoutMs,
      );
    const response =
      method === "GET"
        ? await withRemoteRetry(executeRequest, {
            retries: 2,
            retryDelayMs: 700,
          })
        : await executeRequest();

    if (response.status < 200 || response.status >= 300) {
      const error =
        response.body &&
        typeof response.body === "object" &&
        !Array.isArray(response.body) &&
        typeof (response.body as { error?: string }).error === "string"
          ? (response.body as { error: string }).error
          : `Request failed with status ${response.status}`;
      throw new Error(error);
    }

    return response.body as T;
  }

  public async callRemote<T>(
    method: string,
    body: unknown,
    timeoutMs: number = DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (!this.serverUrl) {
      throw new Error("Remote client is not authenticated");
    }
    if (!this.selectedMachineId) {
      throw new Error("Remote machine is not selected");
    }
    const machineId = this.selectedMachineId;
    if (!this.relayKey) {
      throw new Error("Remote credential is not available");
    }

    const shouldLogTiming = this.remoteLatencyLoggingEnabled;
    const requestSummary =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { method?: unknown; path?: unknown })
        : null;
    const proxiedMethod =
      typeof requestSummary?.method === "string"
        ? requestSummary.method
        : "UNKNOWN";
    const proxiedPath =
      typeof requestSummary?.path === "string"
        ? requestSummary.path
        : "unknown";

    const requestId = createRequestId();
    let stage = "encrypt";
    const startedAt = monotonicNow();
    let encryptMs = 0;
    let relayMs = 0;
    let decryptMs = 0;
    let requestBytes = 0;
    let responseBytes = 0;
    let responseStatus: number | null = null;

    try {
      const encryptStartedAt = monotonicNow();
      const params = await encryptRemotePayload(this.relayKey, {
        requestId,
        body,
      } satisfies RemoteRpcRequestEnvelope);
      encryptMs = monotonicNow() - encryptStartedAt;
      requestBytes = params.length;

      stage = "relay";
      const relayStartedAt = monotonicNow();
      const rawResponse = await requestJson<RemoteRouteResponse>(
        new URL(
          `/v1/remote/http/${encodeURIComponent(machineId)}`,
          this.serverUrl,
        ),
        {
          method: "POST",
          headers: {
            ...this.buildAuthHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ params }),
        },
        timeoutMs,
      );
      relayMs = monotonicNow() - relayStartedAt;

      if (!rawResponse.ok || !rawResponse.result) {
        throw new Error(rawResponse.error || "Remote RPC failed");
      }
      if (
        rawResponse.signatureVersion !== 1 ||
        typeof rawResponse.signature !== "string" ||
        !rawResponse.signature ||
        typeof rawResponse.signerPublicKey !== "string" ||
        !rawResponse.signerPublicKey
      ) {
        throw new Error(
          "Remote RPC response is missing a CLI signature. Update the remote CLI and server.",
        );
      }
      const pinnedMachineSigningPublicKey =
        this.machineSigningPublicKeys[machineId];
      if (!pinnedMachineSigningPublicKey) {
        throw new Error(
          `No pinned CLI identity is available for machine ${machineId}.`,
        );
      }
      if (rawResponse.signerPublicKey !== pinnedMachineSigningPublicKey) {
        throw new Error(`Remote RPC signer mismatch for machine ${machineId}.`);
      }
      const signatureValid = verifyRemoteRpcResultSignature({
        machineId,
        requestId,
        encryptedResult: rawResponse.result,
        signature: rawResponse.signature,
        publicKey: pinnedMachineSigningPublicKey,
      });
      if (!signatureValid) {
        throw new Error(
          `Remote RPC signature verification failed for machine ${machineId}.`,
        );
      }

      stage = "decrypt";
      responseBytes = rawResponse.result.length;
      const decryptStartedAt = monotonicNow();
      const response = await decryptRemotePayload<RemoteRpcResultEnvelope>(
        this.relayKey,
        rawResponse.result,
      );
      decryptMs = monotonicNow() - decryptStartedAt;

      if (!response.ok) {
        throw new Error(response.error || "Remote RPC failed");
      }
      if (response.requestId !== requestId) {
        throw new Error("Mismatched remote RPC response");
      }

      const bodyWithStatus =
        response.body &&
        typeof response.body === "object" &&
        !Array.isArray(response.body)
          ? (response.body as { status?: unknown })
          : null;
      responseStatus =
        typeof bodyWithStatus?.status === "number"
          ? bodyWithStatus.status
          : null;

      if (shouldLogTiming) {
        const totalMs = monotonicNow() - startedAt;
        console.log(
          `[codex-deck remote timing][browser] ${proxiedMethod} ${proxiedPath} requestId=${requestId} total=${totalMs.toFixed(1)}ms encrypt=${encryptMs.toFixed(1)}ms relay=${relayMs.toFixed(1)}ms decrypt=${decryptMs.toFixed(1)}ms reqBytes=${requestBytes} resBytes=${responseBytes} status=${responseStatus ?? "unknown"} machine=${machineId}`,
        );
      }

      return response.body as T;
    } catch (error) {
      if (shouldLogTiming) {
        const totalMs = monotonicNow() - startedAt;
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          `[codex-deck remote timing][browser] ${proxiedMethod} ${proxiedPath} requestId=${requestId} total=${totalMs.toFixed(1)}ms encrypt=${encryptMs.toFixed(1)}ms relay=${relayMs.toFixed(1)}ms decrypt=${decryptMs.toFixed(1)}ms reqBytes=${requestBytes} resBytes=${responseBytes} status=${responseStatus ?? "unknown"} stage=${stage} error=${message} machine=${machineId}`,
        );
      }
      this.invalidateRemoteAuthStateOnFailure(error);
      throw error;
    }
  }

  private buildAuthHeaders(): Record<string, string> {
    return this.token
      ? {
          Authorization: `Bearer ${this.token}`,
        }
      : {};
  }

  private async fetchBootstrap(
    serverUrl: string,
    pins?: RemoteServerTrustPins,
  ): Promise<BootstrapResponse> {
    const bootstrap = await requestJson<BootstrapResponse>(
      new URL("/v1/auth/bootstrap", serverUrl),
    );
    if (bootstrap.remoteAuthVersion !== 2) {
      throw new Error("Unsupported remote auth version.");
    }
    const normalizedPins = this.normalizePins(pins);
    if (
      normalizedPins.realmId &&
      bootstrap.realmId !== normalizedPins.realmId
    ) {
      throw new Error(
        `Remote auth realm mismatch. Expected ${normalizedPins.realmId}, got ${bootstrap.realmId}.`,
      );
    }
    if (
      normalizedPins.opaqueServerPublicKey &&
      bootstrap.opaqueServerPublicKey !== normalizedPins.opaqueServerPublicKey
    ) {
      throw new Error(
        "Remote OPAQUE server public key mismatch. Refusing to trust bootstrap from server.",
      );
    }
    return bootstrap;
  }

  private async authenticateBrowser(
    password: string,
    loginHandle: string,
    bootstrap: BootstrapResponse,
    remember: boolean,
  ): Promise<{ token: string; exportKey: string; relayKey: Uint8Array }> {
    if (!this.serverUrl) {
      throw new Error("Remote server URL is not configured");
    }

    const loginStart = await startRemoteOpaqueLogin(password);
    let loginStartResponse: OpaqueLoginStartResponse;
    try {
      loginStartResponse = await requestJson<OpaqueLoginStartResponse>(
        new URL("/v1/auth/opaque/login/start", this.serverUrl),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            loginHandle,
            clientKind: "browser",
            startLoginRequest: loginStart.startLoginRequest,
          }),
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
          context: "browser",
          code: cause?.code ?? null,
          error:
            cause?.error ?? (error instanceof Error ? error.message : null),
        }),
      );
    }
    const loginFinish = await finishRemoteOpaqueLogin({
      password,
      clientLoginState: loginStart.clientLoginState,
      loginResponse: loginStartResponse.loginResponse,
      loginHandle,
      realmId: bootstrap.realmId,
      expectedServerPublicKey: bootstrap.opaqueServerPublicKey,
    });
    if (!loginFinish) {
      throw new Error(
        getRemoteAuthHint({
          context: "browser",
          code: RemoteAuthErrorCode.invalidLogin,
        }),
      );
    }
    let authResponse: OpaqueLoginFinishResponse;
    try {
      authResponse = await requestJson<OpaqueLoginFinishResponse>(
        new URL("/v1/auth/opaque/login/finish", this.serverUrl),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            loginId: loginStartResponse.loginId,
            finishLoginRequest: loginFinish.finishLoginRequest,
            remember,
          }),
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
          context: "browser",
          code: cause?.code ?? null,
          error:
            cause?.error ?? (error instanceof Error ? error.message : null),
        }),
      );
    }
    return {
      token: authResponse.token,
      exportKey: loginFinish.exportKey,
      relayKey: loginFinish.relayKey,
    };
  }

  private async connectSocket(): Promise<void> {
    if (!this.serverUrl || (!this.token && !this.relayKey)) {
      throw new Error("Remote client is not authenticated");
    }

    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = io(toWebSocketUrl(this.serverUrl!), {
        transports: ["websocket"],
        auth: {
          ...(this.token ? { token: this.token } : {}),
          clientType: "user-scoped",
        },
        withCredentials: true,
        path: "/v1/updates",
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      socket.once("connect", () => {
        this.socket = socket;
        socket.on("connect", () => {
          this.emitChange();
        });
        resolve();
      });
      socket.once("connect_error", (error) => {
        this.invalidateRemoteAuthStateOnFailure(error);
        reject(error);
      });
      socket.on("connect_error", (error) => {
        this.invalidateRemoteAuthStateOnFailure(error);
      });
      socket.on("disconnect", () => {
        this.emitChange();
      });
    });
  }

  private persistState(): void {
    if (
      !this.serverUrl ||
      !this.loginHandle ||
      !this.exportKey ||
      !this.realmId ||
      !this.pinnedOpaqueServerPublicKey
    ) {
      return;
    }

    saveStoredState(
      this.serverUrl,
      {
        loginHandle: this.loginHandle,
        exportKey: this.exportKey,
        realmId: this.realmId,
        pinnedOpaqueServerPublicKey: this.pinnedOpaqueServerPublicKey,
        machineSigningPublicKeys: this.machineSigningPublicKeys,
        selectedMachineId: this.selectedMachineId,
      },
      this.browserPersistence,
    );
  }

  private async resetRuntime(): Promise<void> {
    this.socket?.disconnect();
    this.socket = null;
    this.token = null;
    this.loginHandle = null;
    this.exportKey = null;
    this.relayKey = null;
    this.realmId = null;
    this.pinnedOpaqueServerPublicKey = null;
    this.machineSigningPublicKeys = {};
    this.serverUrl = null;
    this.machines = [];
    this.selectedMachineId = null;
    this.browserPersistence = "session";
  }

  private invalidateRemoteAuthStateOnFailure(error: unknown): void {
    if (!isRemoteAuthenticationError(error)) {
      return;
    }

    const hadRemoteAuthState =
      this.serverUrl !== null ||
      this.relayKey !== null ||
      this.token !== null ||
      this.selectedMachineId !== null;
    if (!hadRemoteAuthState) {
      return;
    }

    this.socket?.disconnect();
    this.socket = null;
    this.token = null;
    this.relayKey = null;
    this.machines = [];
    this.machineSigningPublicKeys = {};
    this.selectedMachineId = null;
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
