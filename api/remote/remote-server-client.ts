import { hostname, platform } from "os";
import { readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";
import { io, type Socket } from "socket.io-client";
import {
  decryptRemotePayload,
  deriveRemoteLoginHandle,
  encryptRemotePayload,
  finishRemoteOpaqueLogin,
  finishRemoteOpaqueRegistration,
  generateRemoteRpcSigningKeyPair,
  getRemoteAuthHint,
  RemoteAuthErrorCode,
  signRemoteRpcResult,
  startRemoteOpaqueLogin,
  startRemoteOpaqueRegistration,
  type RemoteMachineMetadata,
  type RemoteMachineState,
} from "@zuoyehaoduoa/wire";
import { INTERNAL_REMOTE_PROXY_ACCESS_HEADER } from "./internal-proxy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HEARTBEAT_INTERVAL_MS = 20_000;
const REMOTE_RPC_TIMING_LOG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.CODEXDECK_REMOTE_RPC_TIMING_LOG ?? "",
);
const REMOTE_ACCOUNT_NOT_FOUND_ERROR =
  "Remote account not found. Start the CLI first.";
const REMOTE_ACCOUNT_NOT_FOUND_CODE = RemoteAuthErrorCode.accountNotFound;
const REMOTE_AUTH_UPGRADE_ERROR =
  "Legacy remote auth has been removed. Re-register the CLI with the current codex-deck version.";
const REMOTE_AUTH_UPGRADE_CODE = RemoteAuthErrorCode.authUpgradeRequired;
const RPC_SIGNING_KEY_FILE_VERSION = 1;
const REMOTE_BOOTSTRAP_LOGIN_URL_SERVER_PARAM = "codexdeck_remote_server_url";
const REMOTE_BOOTSTRAP_LOGIN_URL_REALM_PARAM = "codexdeck_remote_realm_id";
const REMOTE_BOOTSTRAP_LOGIN_URL_OPAQUE_KEY_PARAM =
  "codexdeck_remote_opaque_server_key";

type MachineUpdateAck =
  | { result: "error"; message?: string }
  | { result: "version-mismatch"; version: number; daemonState?: string }
  | { result: "success"; version: number; daemonState?: string };

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

interface RemoteSignedRpcResult {
  result: string;
  signature: string;
  signerPublicKey: string;
  signatureVersion: 1;
}

interface RemoteServerClientOptions {
  serverUrl: string;
  username: string;
  password: string;
  setupToken: string;
  machineId: string;
  codexDir: string;
  localPort: number;
  appFetch: (request: Request) => Promise<Response>;
  internalProxyAccessToken?: string | null;
  pinnedRealmId?: string | null;
  pinnedOpaqueServerPublicKey?: string | null;
}

interface RemoteBootstrapResponse {
  remoteAuthVersion: 2;
  realmId: string;
  opaqueServerPublicKey: string;
}

interface RemoteOpaqueStartResponse {
  loginId?: string;
  loginResponse?: string;
  registrationId?: string;
  registrationResponse?: string;
  error?: string;
  code?: string;
}

interface RemoteOpaqueFinishResponse {
  success?: boolean;
  token?: string;
  error?: string;
  code?: string;
}

interface RemoteAuthFailurePayload {
  error?: string;
  code?: string;
}

function jsonByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf-8");
  } catch {
    return -1;
  }
}

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function toWebSocketUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/i, (match) =>
    match.toLowerCase() === "https" ? "wss" : "ws",
  );
}

function ensureAllowedProxyPath(path: string): void {
  if (!path.startsWith("/api/")) {
    throw new Error("Only /api/* proxy paths are allowed");
  }
  if (
    path.startsWith("/api/sessions/stream") ||
    (path.startsWith("/api/conversation/") && path.includes("/stream")) ||
    path.startsWith("/api/terminals/stream") ||
    (path.startsWith("/api/terminals/") && path.includes("/stream"))
  ) {
    throw new Error(
      "Stream endpoints are not available through remote HTTP proxy",
    );
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function parseExpectedJsonResponse<T>(
  response: Response,
  context: string,
): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = response.headers.get("content-type") || "unknown";
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(
      `${context} returned a non-JSON response (${response.status}, ${contentType})${preview ? `: ${preview}` : ""}`,
    );
  }
}

function getAuthFailureHint(
  payload: RemoteAuthFailurePayload | null | undefined,
  fallback: string,
): string {
  return getRemoteAuthHint({
    context: "cli",
    code: payload?.code ?? null,
    error: payload?.error ?? fallback,
  });
}

function isSocketDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /socket has been disconnected/i.test(error.message)
  );
}

function formatHeartbeatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class RemoteServerClient {
  private socket: Socket | null = null;
  private token: string | null = null;
  private relayKey: Uint8Array | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private metadataVersion = 0;
  private daemonStateVersion = 0;
  private daemonState: RemoteMachineState = {
    status: "running",
    connectedAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    localWebUrl: null,
  };
  private rpcRequestHandlerBound = false;
  private rpcSigningPublicKey: string | null = null;
  private rpcSigningSecretKey: string | null = null;
  private lastBootstrap: RemoteBootstrapResponse | null = null;

  public constructor(private readonly options: RemoteServerClientOptions) {}

  private getPinnedRealmId(): string | null {
    const pinned = this.options.pinnedRealmId?.trim();
    return pinned && pinned.length > 0 ? pinned : null;
  }

  private getPinnedOpaqueServerPublicKey(): string | null {
    const pinned = this.options.pinnedOpaqueServerPublicKey?.trim();
    return pinned && pinned.length > 0 ? pinned : null;
  }

  private getSigningKeyFilePath(): string {
    return join(
      this.options.codexDir,
      "remote",
      `rpc-signing-key-${this.options.machineId}.json`,
    );
  }

  private async ensureRpcSigningIdentity(): Promise<void> {
    if (this.rpcSigningPublicKey && this.rpcSigningSecretKey) {
      return;
    }

    const keyPath = this.getSigningKeyFilePath();
    try {
      const raw = await readFile(keyPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        machineId?: unknown;
        publicKey?: unknown;
        secretKey?: unknown;
      };
      if (
        parsed.version !== RPC_SIGNING_KEY_FILE_VERSION ||
        typeof parsed.machineId !== "string" ||
        parsed.machineId !== this.options.machineId ||
        typeof parsed.publicKey !== "string" ||
        !parsed.publicKey.trim() ||
        typeof parsed.secretKey !== "string" ||
        !parsed.secretKey.trim()
      ) {
        throw new Error("Invalid RPC signing key file");
      }
      this.rpcSigningPublicKey = parsed.publicKey.trim();
      this.rpcSigningSecretKey = parsed.secretKey.trim();
      return;
    } catch (error) {
      const errorCode =
        error &&
        typeof error === "object" &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : null;
      if (errorCode !== "ENOENT") {
        throw new Error(
          `Failed to load remote RPC signing key at ${keyPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await mkdir(join(this.options.codexDir, "remote"), { recursive: true });
    const keyPair = generateRemoteRpcSigningKeyPair();
    await writeFile(
      keyPath,
      JSON.stringify(
        {
          version: RPC_SIGNING_KEY_FILE_VERSION,
          machineId: this.options.machineId,
          publicKey: keyPair.publicKey,
          secretKey: keyPair.secretKey,
        },
        null,
        2,
      ),
      { encoding: "utf-8", mode: 0o600 },
    );
    this.rpcSigningPublicKey = keyPair.publicKey;
    this.rpcSigningSecretKey = keyPair.secretKey;
  }

  private buildSignedRpcResult(
    requestId: string,
    encryptedResult: string,
  ): RemoteSignedRpcResult {
    if (!this.rpcSigningPublicKey || !this.rpcSigningSecretKey) {
      throw new Error("Remote RPC signing identity is not initialized");
    }
    return {
      result: encryptedResult,
      signature: signRemoteRpcResult({
        machineId: this.options.machineId,
        requestId,
        encryptedResult,
        secretKey: this.rpcSigningSecretKey,
      }),
      signerPublicKey: this.rpcSigningPublicKey,
      signatureVersion: 1,
    };
  }

  public async start(): Promise<void> {
    const bootstrap = await this.fetchBootstrap();
    this.lastBootstrap = bootstrap;
    const loginHandle = await deriveRemoteLoginHandle(
      this.options.username,
      bootstrap.realmId,
    );
    const authResult = await this.authenticateCli(bootstrap, loginHandle);
    this.relayKey = authResult.relayKey;
    this.token = authResult.token;
    await this.ensureRpcSigningIdentity();
    await this.registerMachine();
    await this.connectSocket();
  }

  public getFirstLoginBootstrapUrl(): string | null {
    if (!this.lastBootstrap) {
      return null;
    }
    const serverUrl = this.options.serverUrl.trim().replace(/\/+$/, "");
    if (!serverUrl) {
      return null;
    }
    const url = new URL(serverUrl);
    url.searchParams.set(REMOTE_BOOTSTRAP_LOGIN_URL_SERVER_PARAM, serverUrl);
    url.searchParams.set(
      REMOTE_BOOTSTRAP_LOGIN_URL_REALM_PARAM,
      this.lastBootstrap.realmId,
    );
    url.searchParams.set(
      REMOTE_BOOTSTRAP_LOGIN_URL_OPAQUE_KEY_PARAM,
      this.lastBootstrap.opaqueServerPublicKey,
    );
    return url.toString();
  }

  public async stop(): Promise<void> {
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.disconnect();
    }
  }

  private async fetchBootstrap(): Promise<RemoteBootstrapResponse> {
    const response = await fetch(
      new URL("/v1/auth/bootstrap", this.options.serverUrl),
    );
    const payload = (await parseExpectedJsonResponse(
      response,
      "Remote server response",
    )) as RemoteBootstrapResponse & {
      error?: string;
      code?: string;
    };
    if (!response.ok || !payload.realmId) {
      throw new Error(
        getAuthFailureHint(
          payload,
          `Failed to load remote auth bootstrap (${response.status})`,
        ),
      );
    }
    if (payload.remoteAuthVersion !== 2 || !payload.opaqueServerPublicKey) {
      throw new Error("Unsupported remote auth bootstrap response");
    }
    const pinnedRealmId = this.getPinnedRealmId();
    if (pinnedRealmId && pinnedRealmId !== payload.realmId) {
      throw new Error(
        `Remote auth realm mismatch. Expected ${pinnedRealmId}, got ${payload.realmId}.`,
      );
    }
    const pinnedOpaqueServerPublicKey = this.getPinnedOpaqueServerPublicKey();
    if (
      pinnedOpaqueServerPublicKey &&
      pinnedOpaqueServerPublicKey !== payload.opaqueServerPublicKey
    ) {
      throw new Error(
        "Remote OPAQUE server public key mismatch. Refusing to trust bootstrap from server.",
      );
    }
    return payload;
  }

  private async authenticateCli(
    bootstrap: RemoteBootstrapResponse,
    loginHandle: string,
  ): Promise<{ token: string; relayKey: Uint8Array }> {
    const loginStart = await startRemoteOpaqueLogin(this.options.password);
    const loginStartResponse = await fetch(
      new URL("/v1/auth/opaque/login/start", this.options.serverUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          loginHandle,
          clientKind: "cli",
          machineId: this.options.machineId,
          startLoginRequest: loginStart.startLoginRequest,
        }),
      },
    );
    const loginStartPayload =
      await parseExpectedJsonResponse<RemoteOpaqueStartResponse>(
        loginStartResponse,
        "Remote login start",
      );
    if (loginStartResponse.ok && loginStartPayload.loginId) {
      const loginFinish = await finishRemoteOpaqueLogin({
        password: this.options.password,
        clientLoginState: loginStart.clientLoginState,
        loginResponse: String(loginStartPayload.loginResponse),
        loginHandle,
        realmId: bootstrap.realmId,
        expectedServerPublicKey: bootstrap.opaqueServerPublicKey,
      });
      if (!loginFinish) {
        throw new Error(
          getRemoteAuthHint({
            context: "cli",
            code: RemoteAuthErrorCode.invalidLogin,
          }),
        );
      }
      const finishResponse = await fetch(
        new URL("/v1/auth/opaque/login/finish", this.options.serverUrl),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            loginId: loginStartPayload.loginId,
            finishLoginRequest: loginFinish.finishLoginRequest,
          }),
        },
      );
      const finishPayload =
        await parseExpectedJsonResponse<RemoteOpaqueFinishResponse>(
          finishResponse,
          "Remote login finish",
        );
      if (!finishResponse.ok || !finishPayload.token) {
        throw new Error(
          getAuthFailureHint(
            finishPayload,
            `Failed to authenticate with remote server (${finishResponse.status})`,
          ),
        );
      }
      return {
        token: finishPayload.token,
        relayKey: loginFinish.relayKey,
      };
    }

    if (
      loginStartResponse.status !== 409 ||
      !(
        loginStartPayload.code === REMOTE_ACCOUNT_NOT_FOUND_CODE ||
        loginStartPayload.code === REMOTE_AUTH_UPGRADE_CODE ||
        loginStartPayload.error === REMOTE_ACCOUNT_NOT_FOUND_ERROR ||
        loginStartPayload.error === REMOTE_AUTH_UPGRADE_ERROR
      )
    ) {
      throw new Error(
        getAuthFailureHint(
          loginStartPayload,
          `Failed to authenticate with remote server (${loginStartResponse.status})`,
        ),
      );
    }

    return this.registerCli(bootstrap, loginHandle);
  }

  private async registerCli(
    bootstrap: RemoteBootstrapResponse,
    loginHandle: string,
  ): Promise<{ token: string; relayKey: Uint8Array }> {
    const registrationStart = await startRemoteOpaqueRegistration(
      this.options.password,
    );
    const registrationStartResponse = await fetch(
      new URL("/v1/auth/opaque/register/start", this.options.serverUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          setupToken: this.options.setupToken,
          loginHandle,
          machineId: this.options.machineId,
          registrationRequest: registrationStart.registrationRequest,
        }),
      },
    );
    const registrationStartPayload =
      await parseExpectedJsonResponse<RemoteOpaqueStartResponse>(
        registrationStartResponse,
        "Remote registration start",
      );
    if (
      !registrationStartResponse.ok ||
      !registrationStartPayload.registrationId ||
      !registrationStartPayload.registrationResponse
    ) {
      throw new Error(
        getAuthFailureHint(
          registrationStartPayload,
          `Failed to register remote login (${registrationStartResponse.status})`,
        ),
      );
    }

    const registrationFinish = await finishRemoteOpaqueRegistration({
      password: this.options.password,
      clientRegistrationState: registrationStart.clientRegistrationState,
      registrationResponse: registrationStartPayload.registrationResponse,
      loginHandle,
      realmId: bootstrap.realmId,
      expectedServerPublicKey: bootstrap.opaqueServerPublicKey,
    });
    const registrationFinishResponse = await fetch(
      new URL("/v1/auth/opaque/register/finish", this.options.serverUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          registrationId: registrationStartPayload.registrationId,
          registrationRecord: registrationFinish.registrationRecord,
        }),
      },
    );
    const registrationFinishPayload =
      await parseExpectedJsonResponse<RemoteOpaqueFinishResponse>(
        registrationFinishResponse,
        "Remote registration finish",
      );
    if (!registrationFinishResponse.ok || !registrationFinishPayload.token) {
      throw new Error(
        getAuthFailureHint(
          registrationFinishPayload,
          `Failed to finish remote registration (${registrationFinishResponse.status})`,
        ),
      );
    }

    return {
      token: registrationFinishPayload.token,
      relayKey: registrationFinish.relayKey,
    };
  }

  private buildMachineMetadata(): RemoteMachineMetadata {
    if (!this.rpcSigningPublicKey) {
      throw new Error("Remote RPC signing identity is not initialized");
    }
    return {
      machineId: this.options.machineId,
      label: hostname(),
      host: hostname(),
      platform: platform(),
      codexDir: this.options.codexDir,
      cliVersion: getVersion(),
      rpcSigningPublicKey: this.rpcSigningPublicKey,
    };
  }

  private async registerMachine(): Promise<void> {
    if (!this.token || !this.relayKey) {
      throw new Error("Remote auth is not initialized");
    }

    const metadata = await encryptRemotePayload(
      this.relayKey,
      this.buildMachineMetadata(),
    );
    const daemonState = await encryptRemotePayload(
      this.relayKey,
      this.daemonState,
    );

    const response = await fetch(
      new URL("/v1/machines", this.options.serverUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: this.options.machineId,
          metadata,
          daemonState,
        }),
      },
    );
    const payload = (await parseExpectedJsonResponse(
      response,
      "Remote server response",
    )) as {
      machine?: {
        metadataVersion?: number;
        daemonStateVersion?: number;
      };
      error?: string;
      code?: string;
    };
    if (!response.ok || !payload.machine) {
      throw new Error(
        getAuthFailureHint(
          payload,
          `Failed to register remote machine (${response.status})`,
        ),
      );
    }

    this.metadataVersion = payload.machine.metadataVersion || 0;
    this.daemonStateVersion = payload.machine.daemonStateVersion || 0;
  }

  private async connectSocket(): Promise<void> {
    if (!this.token || !this.relayKey) {
      throw new Error("Remote auth is not initialized");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = io(toWebSocketUrl(this.options.serverUrl), {
        transports: ["websocket"],
        auth: {
          token: this.token,
          clientType: "machine-scoped",
          machineId: this.options.machineId,
        },
        path: "/v1/updates",
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      let settled = false;

      this.registerRpcHandlers(socket);

      const handleConnect = () => {
        this.socket = socket;
        this.startHeartbeat();
        void this.publishDaemonState().catch((error) => {
          console.error(
            "[codex-deck remote] failed to publish daemon state:",
            error,
          );
        });
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      socket.on("connect", () => {
        void handleConnect();
      });
      socket.once("connect_error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      socket.on("disconnect", () => {
        this.stopHeartbeat();
      });
    });
  }

  private registerRpcHandlers(socket: Socket): void {
    if (this.rpcRequestHandlerBound) {
      return;
    }
    this.rpcRequestHandlerBound = true;

    socket.on(
      "rpc-request",
      async (
        data: { method: string; params: string },
        callback: (response: RemoteSignedRpcResult) => void,
      ) => {
        const method = `${this.options.machineId}:http`;
        if (!this.relayKey) {
          return;
        }
        if (data.method !== method) {
          return;
        }

        const startedAt = performance.now();
        let decryptMs = 0;
        let localFetchMs = 0;
        let localParseMs = 0;
        let encryptMs = 0;
        let proxiedMethod = "UNKNOWN";
        let proxiedPath = "unknown";
        let responseStatus: number | null = null;
        let responseBodyBytes = 0;
        const requestBytes = data.params.length;
        let envelope: RemoteRpcRequestEnvelope | null = null;
        try {
          const decryptStartedAt = performance.now();
          envelope = await decryptRemotePayload<RemoteRpcRequestEnvelope>(
            this.relayKey,
            data.params,
          );
          decryptMs = performance.now() - decryptStartedAt;
          const request = envelope.body as RemoteHttpProxyRequest;
          ensureAllowedProxyPath(request.path);
          proxiedMethod = request.method;
          proxiedPath = request.path;

          const url = new URL(request.path, "http://codex-deck.local");
          const init: RequestInit = {
            method: request.method,
            headers: this.options.internalProxyAccessToken
              ? {
                  [INTERNAL_REMOTE_PROXY_ACCESS_HEADER]:
                    this.options.internalProxyAccessToken,
                }
              : {},
          };
          if (request.body !== undefined) {
            init.body = JSON.stringify(request.body);
            (init.headers as Record<string, string>)["Content-Type"] =
              "application/json";
          }

          const localFetchStartedAt = performance.now();
          const response = await this.options.appFetch(new Request(url, init));
          localFetchMs = performance.now() - localFetchStartedAt;
          responseStatus = response.status;

          const localParseStartedAt = performance.now();
          const body = await parseResponseBody(response);
          localParseMs = performance.now() - localParseStartedAt;
          if (REMOTE_RPC_TIMING_LOG_ENABLED) {
            responseBodyBytes = jsonByteLength(body);
          }

          const result: RemoteRpcResultEnvelope = {
            ok: true,
            requestId: envelope.requestId,
            body: {
              status: response.status,
              body,
            } satisfies RemoteHttpProxyResponse,
          };
          const encryptStartedAt = performance.now();
          const encryptedResult = await encryptRemotePayload(
            this.relayKey,
            result,
          );
          encryptMs = performance.now() - encryptStartedAt;
          callback(
            this.buildSignedRpcResult(envelope.requestId, encryptedResult),
          );
          if (REMOTE_RPC_TIMING_LOG_ENABLED) {
            const totalMs = performance.now() - startedAt;
            console.log(
              `[codex-deck remote timing][cli] ${proxiedMethod} ${proxiedPath} requestId=${envelope.requestId} total=${totalMs.toFixed(1)}ms decrypt=${decryptMs.toFixed(1)}ms localFetch=${localFetchMs.toFixed(1)}ms localParse=${localParseMs.toFixed(1)}ms encrypt=${encryptMs.toFixed(1)}ms reqBytes=${requestBytes} responseBodyBytes=${responseBodyBytes} encryptedResponseBytes=${encryptedResult.length} status=${responseStatus ?? "unknown"}`,
            );
          }
        } catch (error) {
          const result: RemoteRpcResultEnvelope = {
            ok: false,
            requestId: envelope?.requestId || "unknown",
            error: error instanceof Error ? error.message : String(error),
          };
          const encryptStartedAt = performance.now();
          const encryptedResult = await encryptRemotePayload(
            this.relayKey,
            result,
          );
          encryptMs = performance.now() - encryptStartedAt;
          callback(
            this.buildSignedRpcResult(
              envelope?.requestId || "unknown",
              encryptedResult,
            ),
          );
          if (REMOTE_RPC_TIMING_LOG_ENABLED) {
            const totalMs = performance.now() - startedAt;
            const message =
              error instanceof Error ? error.message : String(error);
            console.log(
              `[codex-deck remote timing][cli] ${proxiedMethod} ${proxiedPath} requestId=${envelope?.requestId ?? "unknown"} total=${totalMs.toFixed(1)}ms decrypt=${decryptMs.toFixed(1)}ms localFetch=${localFetchMs.toFixed(1)}ms localParse=${localParseMs.toFixed(1)}ms encrypt=${encryptMs.toFixed(1)}ms reqBytes=${requestBytes} status=${responseStatus ?? "unknown"} error=${message}`,
            );
          }
        }
      },
    );
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || !socket.connected) {
        return;
      }
      const now = Date.now();
      this.daemonState = {
        ...this.daemonState,
        status: "running",
        lastHeartbeatAt: now,
      };
      socket.emit("machine-alive", {
        machineId: this.options.machineId,
        time: now,
      });
      void this.publishDaemonState().catch((error) => {
        console.error(
          "[codex-deck remote] heartbeat state update failed:",
          formatHeartbeatError(error),
        );
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async publishDaemonState(): Promise<void> {
    const socket = this.socket;
    if (!socket || !socket.connected || !this.relayKey) {
      return;
    }

    const encrypted = await encryptRemotePayload(
      this.relayKey,
      this.daemonState,
    );
    const answer = (await socket.emitWithAck("machine-update-state", {
      machineId: this.options.machineId,
      daemonState: encrypted,
      expectedVersion: this.daemonStateVersion,
    })) as MachineUpdateAck;

    if (answer.result === "success") {
      this.daemonStateVersion = answer.version;
    } else if (answer.result === "version-mismatch") {
      this.daemonStateVersion = answer.version;
    }
  }
}
