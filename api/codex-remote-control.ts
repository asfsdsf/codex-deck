import { nativePages, nativeRecord, type NativeRpc } from "./codex-native";

// Codex's own remote-control transport (`remoteControl/*`). This is unrelated
// to Deck's remote server/cli relay in `api/remote/` and `web/remote-client.ts`.

export type RemoteControlConnectionStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "errored";

export interface RemoteControlStatus {
  status: RemoteControlConnectionStatus;
  serverName: string;
  installationId: string;
  environmentId: string | null;
}

export interface RemoteControlClientInfo {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  /** Unix seconds. */
  lastSeenAt: number | null;
}

export interface RemoteControlPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  environmentId: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface RemoteControlSnapshot {
  available: boolean;
  unavailableReason: string | null;
  status: RemoteControlStatus | null;
  clients: RemoteControlClientInfo[];
  clientsError: string | null;
}

// Methods whose params are optional are sent without a params object.
const NO_PARAMS = undefined as unknown as Record<string, unknown>;
const STATUSES = new Set(["disabled", "connecting", "connected", "errored"]);

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const code = (error: unknown) => {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === "number" ? value : null;
};

export function isRemoteControlUnsupported(error: unknown): boolean {
  return (
    code(error) === -32601 ||
    /unknown variant|method not found|requires experimentalApi/i.test(
      message(error),
    )
  );
}

/** Older servers reject the optional params object; the CLI retries bare. */
function isParamsRejected(error: unknown): boolean {
  return (
    code(error) === -32602 ||
    /invalid params|unknown field/i.test(message(error))
  );
}

export function parseRemoteControlStatus(value: unknown): RemoteControlStatus {
  const record = nativeRecord(value);
  if (
    typeof record.status !== "string" ||
    !STATUSES.has(record.status) ||
    typeof record.serverName !== "string" ||
    typeof record.installationId !== "string"
  )
    throw new Error("Invalid remote-control status");
  return {
    status: record.status as RemoteControlConnectionStatus,
    serverName: record.serverName,
    installationId: record.installationId,
    environmentId: optionalString(record.environmentId),
  };
}

function parseClient(value: unknown): RemoteControlClientInfo {
  const record = nativeRecord(value);
  if (typeof record.clientId !== "string" || !record.clientId)
    throw new Error("Invalid remote-control client");
  return {
    clientId: record.clientId,
    displayName: optionalString(record.displayName),
    deviceType: optionalString(record.deviceType),
    platform: optionalString(record.platform),
    osVersion: optionalString(record.osVersion),
    deviceModel: optionalString(record.deviceModel),
    appVersion: optionalString(record.appVersion),
    lastSeenAt: optionalNumber(record.lastSeenAt),
  };
}

export class RemoteControlService {
  public constructor(
    private readonly rpc: NativeRpc,
    private readonly notify: () => void,
  ) {}

  private async requestWithLegacyFallback(
    method: string,
    params: Record<string, unknown> | null,
  ): Promise<unknown> {
    try {
      return await this.rpc(method, params ?? NO_PARAMS);
    } catch (error) {
      if (!params || !isParamsRejected(error)) throw error;
      return this.rpc(method, NO_PARAMS);
    }
  }

  public async snapshot(): Promise<RemoteControlSnapshot> {
    let status: RemoteControlStatus;
    try {
      status = parseRemoteControlStatus(
        await this.rpc("remoteControl/status/read", NO_PARAMS),
      );
    } catch (error) {
      if (!isRemoteControlUnsupported(error)) throw error;
      return {
        available: false,
        unavailableReason: message(error),
        status: null,
        clients: [],
        clientsError: null,
      };
    }
    let clients: RemoteControlClientInfo[] = [];
    let clientsError: string | null = null;
    if (status.environmentId) {
      try {
        clients = (
          await nativePages<unknown>(this.rpc, "remoteControl/client/list", {
            environmentId: status.environmentId,
            order: "desc",
          })
        ).map(parseClient);
      } catch (error) {
        clientsError = message(error);
      }
    }
    return {
      available: true,
      unavailableReason: null,
      status,
      clients,
      clientsError,
    };
  }

  public async setEnabled(
    enabled: boolean,
    ephemeral: boolean,
  ): Promise<RemoteControlStatus> {
    const status = parseRemoteControlStatus(
      await this.requestWithLegacyFallback(
        enabled ? "remoteControl/enable" : "remoteControl/disable",
        ephemeral ? { ephemeral: true } : null,
      ),
    );
    this.notify();
    return status;
  }

  public async startPairing(): Promise<RemoteControlPairing> {
    const record = nativeRecord(
      await this.requestWithLegacyFallback("remoteControl/pairing/start", {
        manualCode: true,
      }),
    );
    const expiresAt = optionalNumber(record.expiresAt);
    if (
      typeof record.pairingCode !== "string" ||
      !record.pairingCode ||
      typeof record.environmentId !== "string" ||
      expiresAt === null
    )
      throw new Error("Invalid remote-control pairing response");
    return {
      pairingCode: record.pairingCode,
      manualPairingCode: optionalString(record.manualPairingCode),
      environmentId: record.environmentId,
      expiresAt,
    };
  }

  public async pairingStatus(input: {
    pairingCode?: string | null;
    manualPairingCode?: string | null;
  }): Promise<{ claimed: boolean }> {
    const record = nativeRecord(
      await this.rpc("remoteControl/pairing/status", {
        ...(input.pairingCode ? { pairingCode: input.pairingCode } : {}),
        ...(input.manualPairingCode
          ? { manualPairingCode: input.manualPairingCode }
          : {}),
      }),
    );
    if (typeof record.claimed !== "boolean")
      throw new Error("Invalid remote-control pairing status");
    // A claimed pairing adds a client; refresh every open dialog.
    if (record.claimed) this.notify();
    return { claimed: record.claimed };
  }

  public async revokeClient(
    environmentId: string,
    clientId: string,
  ): Promise<void> {
    await this.rpc("remoteControl/client/revoke", { environmentId, clientId });
    this.notify();
  }

  public handleNotification(method: string): boolean {
    if (method !== "remoteControl/status/changed") return false;
    this.notify();
    return true;
  }
}
