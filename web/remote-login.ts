import { type RemoteServerTrustPins } from "./api";

export function loadRemoteBootstrapConfig(): {
  enabled: boolean;
  serverUrl: string;
  pinnedRealmId: string;
  pinnedOpaqueServerPublicKey: string;
} {
  if (typeof window === "undefined") {
    return {
      enabled: false,
      serverUrl: "",
      pinnedRealmId: "",
      pinnedOpaqueServerPublicKey: "",
    };
  }

  const bootstrap = (
    window as Window & {
      __CODEX_DECK_REMOTE_DEFAULT__?: {
        enabled?: unknown;
        serverUrl?: unknown;
        pinnedRealmId?: unknown;
        pinnedOpaqueServerPublicKey?: unknown;
      };
    }
  ).__CODEX_DECK_REMOTE_DEFAULT__;

  if (!bootstrap || bootstrap.enabled !== true) {
    return {
      enabled: false,
      serverUrl: "",
      pinnedRealmId: "",
      pinnedOpaqueServerPublicKey: "",
    };
  }

  const defaultServerUrl =
    typeof bootstrap.serverUrl === "string" && bootstrap.serverUrl.trim()
      ? bootstrap.serverUrl.trim()
      : window.location.origin;
  const bootstrapLoginUrlFromLocation =
    getRemoteBootstrapLoginUrlFromLocation();

  return {
    enabled: true,
    serverUrl: bootstrapLoginUrlFromLocation ?? defaultServerUrl,
    pinnedRealmId:
      typeof bootstrap.pinnedRealmId === "string" &&
      bootstrap.pinnedRealmId.trim()
        ? bootstrap.pinnedRealmId.trim()
        : "",
    pinnedOpaqueServerPublicKey:
      typeof bootstrap.pinnedOpaqueServerPublicKey === "string" &&
      bootstrap.pinnedOpaqueServerPublicKey.trim()
        ? bootstrap.pinnedOpaqueServerPublicKey.trim()
        : "",
  };
}

const REMOTE_BOOTSTRAP_LOGIN_URL_SERVER_PARAM = "codexdeck_remote_server_url";
const REMOTE_BOOTSTRAP_LOGIN_URL_REALM_PARAM = "codexdeck_remote_realm_id";
const REMOTE_BOOTSTRAP_LOGIN_URL_OPAQUE_KEY_PARAM =
  "codexdeck_remote_opaque_server_key";

function getRemoteBootstrapLoginUrlFromLocation(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const currentUrl = new URL(window.location.href);
    const hasBootstrapParams = [
      REMOTE_BOOTSTRAP_LOGIN_URL_SERVER_PARAM,
      REMOTE_BOOTSTRAP_LOGIN_URL_REALM_PARAM,
      REMOTE_BOOTSTRAP_LOGIN_URL_OPAQUE_KEY_PARAM,
    ].some((param) => {
      const value = currentUrl.searchParams.get(param);
      return typeof value === "string" && value.trim().length > 0;
    });
    if (!hasBootstrapParams) {
      return null;
    }
    return currentUrl.toString();
  } catch {
    return null;
  }
}

function parseRemoteLoginInputUrl(rawInput: string): URL | null {
  const trimmedInput = rawInput.trim();
  if (!trimmedInput) {
    return null;
  }

  const candidates = new Set<string>();
  candidates.add(trimmedInput);

  const unwrappedInput = trimmedInput.replace(/^["']+|["']+$/g, "");
  if (unwrappedInput) {
    candidates.add(unwrappedInput);
    candidates.add(unwrappedInput.replace(/&amp;/gi, "&"));
  }

  const embeddedUrlMatch = unwrappedInput.match(/https?:\/\/[^\s"'<>]+/i);
  if (embeddedUrlMatch?.[0]) {
    candidates.add(embeddedUrlMatch[0]);
  }

  for (const candidate of candidates) {
    try {
      return new URL(candidate);
    } catch {
      // Ignore invalid candidates and try the next one.
    }
  }

  return null;
}

export function rawInputIncludesBootstrapPinHints(rawInput: string): boolean {
  const normalized = rawInput.trim().replace(/&amp;/gi, "&");
  if (!normalized) {
    return false;
  }

  const realmHint =
    /codexdeck_remote_realm_id=([^&#\s]+)/i.exec(normalized)?.[1] ?? "";
  const opaqueKeyHint =
    /codexdeck_remote_opaque_server_key=([^&#\s]+)/i.exec(normalized)?.[1] ??
    "";

  return realmHint.trim().length > 0 || opaqueKeyHint.trim().length > 0;
}

export function resolveRemoteLoginTarget(
  rawServerInput: string,
  bootstrapDefaults: {
    pinnedRealmId: string;
    pinnedOpaqueServerPublicKey: string;
  },
): { serverUrl: string; pins: RemoteServerTrustPins } {
  const trimmedInput = rawServerInput.trim();
  const defaultRealmId = bootstrapDefaults.pinnedRealmId.trim();
  const defaultOpaqueServerPublicKey =
    bootstrapDefaults.pinnedOpaqueServerPublicKey.trim();
  const defaultPins: RemoteServerTrustPins = {
    realmId: defaultRealmId || null,
    opaqueServerPublicKey: defaultOpaqueServerPublicKey || null,
  };
  if (!trimmedInput) {
    return {
      serverUrl: "",
      pins: defaultPins,
    };
  }

  const parsedInput = parseRemoteLoginInputUrl(trimmedInput);
  if (!parsedInput) {
    return {
      serverUrl: trimmedInput,
      pins: defaultPins,
    };
  }

  const pinnedRealmId =
    parsedInput.searchParams.get(REMOTE_BOOTSTRAP_LOGIN_URL_REALM_PARAM) ||
    defaultRealmId;
  const pinnedOpaqueServerPublicKey =
    parsedInput.searchParams.get(REMOTE_BOOTSTRAP_LOGIN_URL_OPAQUE_KEY_PARAM) ||
    defaultOpaqueServerPublicKey;
  const explicitServerUrl =
    parsedInput.searchParams.get(REMOTE_BOOTSTRAP_LOGIN_URL_SERVER_PARAM) || "";
  const normalizedServerUrl = explicitServerUrl.trim()
    ? explicitServerUrl.trim().replace(/\/+$/, "")
    : `${parsedInput.origin}${parsedInput.pathname === "/" ? "" : parsedInput.pathname}`.replace(
        /\/+$/,
        "",
      );

  return {
    serverUrl: normalizedServerUrl,
    pins: {
      realmId: pinnedRealmId.trim() || null,
      opaqueServerPublicKey: pinnedOpaqueServerPublicKey.trim() || null,
    },
  };
}

export function buildRemoteAdminUrl(serverUrl: string): string | null {
  const normalizedServerUrl = serverUrl.trim().replace(/\/+$/, "");
  if (!normalizedServerUrl) {
    return null;
  }

  try {
    return new URL("/admin", normalizedServerUrl).toString();
  } catch {
    return null;
  }
}
