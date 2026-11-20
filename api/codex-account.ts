import { randomUUID } from "node:crypto";
import { nativeRecord, readExperimentalFeatures } from "./codex-native";
import type { ExtensionRpc } from "./codex-extensions";
import { CodexInputError } from "./codex-input-error";

/**
 * Native Codex account onboarding (ChatGPT, device code, API key, Amazon
 * Bedrock, gateway OAuth). This is the Codex CLI account, distinct from
 * Deck's own remote-server login. Credentials are forwarded to app-server and
 * never stored, logged, or returned to browsers.
 */

export type CodexAccountIdentity =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: string | null }
  | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean }
  | { type: string };

export interface CodexPendingLogin {
  id: string;
  loginId: string | null;
  type: "chatgpt" | "chatgptDeviceCode";
  authUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  startedAt: number;
}
export interface CodexLoginResult {
  success: boolean;
  error: string | null;
  at: number;
}
export interface CodexGatewayOAuthState {
  providerId: string;
  providerName: string;
  required: boolean;
  status: string | null;
  error: string | null;
  /** Authorization link while a Deck-started gateway sign-in is active. */
  authUrl: string | null;
  loginInFlight: boolean;
}
export interface CodexAccountSnapshot {
  account: CodexAccountIdentity | null;
  requiresOpenaiAuth: boolean;
  modelProvider: string | null;
  forcedLoginMethod: string | null;
  methods: {
    chatgpt: boolean;
    deviceCode: boolean;
    apiKey: boolean;
    bedrock: boolean;
  };
  gateway: CodexGatewayOAuthState | null;
  pendingLogin: CodexPendingLogin | null;
  lastLogin: CodexLoginResult | null;
  errors: string[];
}
export interface BedrockDiscovery {
  profiles: { name: string; region: string | null }[];
  environmentCredentials: { type: string; region: string | null }[];
}
export type CodexLoginRequest =
  | { type: "chatgpt" }
  | { type: "chatgptDeviceCode" }
  | { type: "apiKey"; apiKey: string }
  | { type: "amazonBedrock"; apiKey: string; region: string }
  | {
      type: "amazonBedrockAccessKeys";
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string | null;
      region: string;
    };
export type BedrockSetupRequest =
  | { type: "profile"; profile: string; region: string }
  | { type: "environment"; region: string };

const GATEWAY_LOGIN_TIMEOUT_MS = 15 * 60_000;
const HTTP_URL = /^https?:\/\//i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function required(value: unknown, name: string): string {
  const result = text(value);
  if (!result) throw new CodexInputError(`${name} is required.`);
  if (result.length > 4096) throw new CodexInputError(`${name} is too long.`);
  return result;
}
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function parseAccount(value: unknown): CodexAccountIdentity | null {
  const account = record(value);
  if (!account || typeof account.type !== "string") return null;
  if (account.type === "chatgpt")
    return {
      type: "chatgpt",
      email: text(account.email),
      planType: text(account.planType),
    };
  if (account.type === "amazonBedrock")
    return {
      type: "amazonBedrock",
      usesCodexManagedCredentials: account.usesCodexManagedCredentials === true,
    };
  return { type: account.type };
}

/** Validates a browser login request into app-server `LoginAccountParams`. */
export function parseLoginRequest(body: unknown): CodexLoginRequest {
  const input = record(body);
  switch (input?.type) {
    case "chatgpt":
      return { type: "chatgpt" };
    case "chatgptDeviceCode":
      return { type: "chatgptDeviceCode" };
    case "apiKey":
      return { type: "apiKey", apiKey: required(input.apiKey, "API key") };
    case "amazonBedrock":
      return {
        type: "amazonBedrock",
        apiKey: required(input.apiKey, "Bedrock API key"),
        region: required(input.region, "AWS region"),
      };
    case "amazonBedrockAccessKeys":
      return {
        type: "amazonBedrockAccessKeys",
        accessKeyId: required(input.accessKeyId, "AWS access key ID"),
        secretAccessKey: required(
          input.secretAccessKey,
          "AWS secret access key",
        ),
        sessionToken: text(input.sessionToken),
        region: required(input.region, "AWS region"),
      };
    default:
      throw new CodexInputError("Unsupported Codex sign-in method.");
  }
}
export function parseBedrockSetup(body: unknown): BedrockSetupRequest {
  const input = record(body);
  if (input?.type === "profile")
    return {
      type: "profile",
      profile: required(input.profile, "AWS profile"),
      region: required(input.region, "AWS region"),
    };
  if (input?.type === "environment")
    return {
      type: "environment",
      region: required(input.region, "AWS region"),
    };
  throw new CodexInputError("Unsupported Bedrock setup method.");
}

export class CodexAccountManager {
  private pendingLogin: CodexPendingLogin | null = null;
  private lastLogin: CodexLoginResult | null = null;
  private gatewayAuthUrl: string | null = null;
  private gatewayLoginInFlight = false;
  private gatewayStatus: { status: string; error: string | null } | null = null;
  private startInFlight = false;

  constructor(
    private readonly rpc: ExtensionRpc,
    private readonly changed: () => void,
  ) {}

  /** Records account notifications; never consumes them (other handlers run). */
  observe(method: string, params: unknown): boolean {
    const value = record(params);
    if (method === "account/login/completed") {
      const loginId = text(value?.loginId);
      if (
        this.pendingLogin &&
        (!loginId ||
          !this.pendingLogin.loginId ||
          this.pendingLogin.loginId === loginId)
      )
        this.pendingLogin = null;
      this.lastLogin = {
        success: value?.success === true,
        error: text(value?.error),
        at: Date.now(),
      };
      this.changed();
      return true;
    }
    if (method === "account/updated") {
      this.changed();
      return true;
    }
    if (method === "account/gatewayOAuth/changed") {
      const status = text(value?.status) ?? "notReady";
      const authUrl = text(value?.authUrl);
      if (status === "started" && authUrl && HTTP_URL.test(authUrl))
        this.gatewayAuthUrl = authUrl;
      else if (status !== "started") this.gatewayAuthUrl = null;
      this.gatewayStatus = { status, error: text(value?.error) };
      this.changed();
      return true;
    }
    return false;
  }

  async read(): Promise<CodexAccountSnapshot> {
    const [account, gateway, config, features] = await Promise.allSettled([
      this.rpc("account/read", {}),
      this.rpc("account/gatewayOAuth/read", undefined),
      this.rpc("config/read", { includeLayers: false }),
      readExperimentalFeatures((method, params) => this.rpc(method, params)),
    ]);
    const errors: string[] = [];
    if (account.status === "rejected")
      errors.push(`Account: ${message(account.reason)}`);
    const accountRecord =
      account.status === "fulfilled" ? record(account.value) : null;
    const configRecord = record(
      config.status === "fulfilled" ? record(config.value)?.config : null,
    );
    const forcedLoginMethod = text(configRecord?.forced_login_method);
    const modelProvider = text(configRecord?.model_provider);
    const bedrockFeature =
      features.status === "fulfilled"
        ? features.value.find((entry) => entry.name === "bedrock_setup_wizard")
        : undefined;
    const apiAllowed = forcedLoginMethod !== "chatgpt";
    const chatgptAllowed = forcedLoginMethod !== "api";
    const gatewayRecord =
      gateway.status === "fulfilled" ? record(gateway.value) : null;
    return {
      account: parseAccount(accountRecord?.account),
      requiresOpenaiAuth: accountRecord?.requiresOpenaiAuth === true,
      modelProvider,
      forcedLoginMethod,
      methods: {
        // Upstream always lists ChatGPT, describing it as disabled when forced.
        chatgpt: chatgptAllowed,
        deviceCode: chatgptAllowed,
        apiKey: apiAllowed,
        bedrock: apiAllowed && (bedrockFeature?.enabled ?? false),
      },
      gateway: gatewayRecord
        ? {
            providerId: text(gatewayRecord.providerId) ?? "",
            providerName:
              text(gatewayRecord.providerName) ??
              text(gatewayRecord.providerId) ??
              "",
            required: gatewayRecord.required === true,
            status: this.gatewayStatus?.status ?? text(gatewayRecord.status),
            error: this.gatewayStatus?.error ?? text(gatewayRecord.error),
            authUrl: this.gatewayAuthUrl,
            loginInFlight: this.gatewayLoginInFlight,
          }
        : null,
      pendingLogin: this.pendingLogin,
      lastLogin: this.lastLogin,
      errors,
    };
  }

  async startLogin(request: CodexLoginRequest): Promise<CodexAccountSnapshot> {
    if (this.startInFlight)
      throw new CodexInputError("A Codex sign-in is already starting.");
    this.startInFlight = true;
    try {
      // Superseding a pending browser/device login cancels it first, as
      // upstream onboarding does when the user picks another method.
      await this.cancelPending();
      const response = nativeRecord(
        await this.rpc("account/login/start", { ...request }),
      );
      if (
        response.type === "chatgpt" ||
        response.type === "chatgptDeviceCode"
      ) {
        const authUrl = text(response.authUrl);
        const verificationUrl = text(response.verificationUrl);
        const url = authUrl ?? verificationUrl;
        if (!url || !HTTP_URL.test(url))
          throw new Error("Invalid Codex sign-in URL from app-server");
        this.pendingLogin = {
          id: randomUUID(),
          loginId: text(response.loginId),
          type: response.type,
          authUrl,
          verificationUrl,
          userCode: text(response.userCode),
          startedAt: Date.now(),
        };
      } else {
        this.lastLogin = { success: true, error: null, at: Date.now() };
      }
      this.changed();
      return this.read();
    } finally {
      this.startInFlight = false;
    }
  }

  private async cancelPending(): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) return;
    this.pendingLogin = null;
    if (!pending.loginId) return;
    try {
      await this.rpc("account/login/cancel", { loginId: pending.loginId });
    } catch {
      // The attempt may already have completed or expired.
    }
  }

  async cancelLogin(id?: string | null): Promise<CodexAccountSnapshot> {
    if (id && this.pendingLogin && this.pendingLogin.id !== id)
      throw new CodexInputError("That sign-in attempt is no longer active.");
    await this.cancelPending();
    this.changed();
    return this.read();
  }

  async logout(): Promise<CodexAccountSnapshot> {
    await this.cancelPending();
    await this.rpc("account/logout", undefined);
    this.lastLogin = null;
    this.changed();
    return this.read();
  }

  async discoverBedrock(): Promise<BedrockDiscovery> {
    const result = nativeRecord(await this.rpc("account/bedrock/discover", {}));
    const profiles = Array.isArray(result.profiles) ? result.profiles : [];
    const environment = Array.isArray(result.environmentCredentials)
      ? result.environmentCredentials
      : [];
    return {
      profiles: profiles
        .map(record)
        .filter((entry) => entry && text(entry.name))
        .map((entry) => ({
          name: text(entry!.name)!,
          region: text(entry!.region),
        })),
      environmentCredentials: environment
        .map(record)
        .filter((entry) => entry && text(entry.type))
        .map((entry) => ({
          type: text(entry!.type)!,
          region: text(entry!.region),
        })),
    };
  }

  /** Bedrock login via API key/access keys or setup via profile/environment. */
  async configureBedrock(
    request: CodexLoginRequest | BedrockSetupRequest,
  ): Promise<{ snapshot: CodexAccountSnapshot; govCloudWarning: boolean }> {
    if (request.type === "profile" || request.type === "environment") {
      await this.rpc("account/bedrock/setup", { ...request });
      this.lastLogin = { success: true, error: null, at: Date.now() };
      this.changed();
    } else if (
      request.type === "amazonBedrock" ||
      request.type === "amazonBedrockAccessKeys"
    ) {
      await this.startLogin(request);
    } else {
      throw new CodexInputError("Unsupported Bedrock setup method.");
    }
    let govCloudWarning = false;
    try {
      const check = record(
        await this.rpc("account/bedrock/checkGovCloudRequirements", {}),
      );
      govCloudWarning = check?.shouldWarn === true;
    } catch {
      // Advisory only; older servers do not implement the check.
    }
    return { snapshot: await this.read(), govCloudWarning };
  }

  async startGatewayLogin(): Promise<CodexAccountSnapshot> {
    if (this.gatewayLoginInFlight)
      throw new CodexInputError("Gateway sign-in is already in progress.");
    this.gatewayLoginInFlight = true;
    this.gatewayAuthUrl = null;
    this.changed();
    // The RPC resolves only after the credential is saved; the authorization
    // link arrives first through `account/gatewayOAuth/changed`.
    void this.rpc("account/gatewayOAuth/login", undefined, {
      timeoutMs: GATEWAY_LOGIN_TIMEOUT_MS,
    })
      .then(
        () => {
          this.gatewayStatus = { status: "succeeded", error: null };
        },
        (reason) => {
          this.gatewayStatus = { status: "failed", error: message(reason) };
        },
      )
      .finally(() => {
        this.gatewayLoginInFlight = false;
        this.gatewayAuthUrl = null;
        this.changed();
      });
    return this.read();
  }

  async cancelGatewayLogin(): Promise<CodexAccountSnapshot> {
    await this.rpc("account/gatewayOAuth/cancel", undefined);
    this.gatewayAuthUrl = null;
    this.changed();
    return this.read();
  }
}
