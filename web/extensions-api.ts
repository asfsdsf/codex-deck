import type {
  CodexPresetsSnapshot,
  CodexPresetInput,
} from "../api/codex-presets";
import { requestJson } from "./transport";

/**
 * Browser API for native Codex account and extension administration. Uses
 * `requestJson`, so it works over both the local and remote transports.
 */
function query(params: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value) search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function getCodexPresets(
  cwd: string | null,
): Promise<CodexPresetsSnapshot> {
  return requestJson(`/api/codex/presets${query({ cwd })}`);
}
export function saveCodexPreset(
  slot: string,
  preset: CodexPresetInput,
  options: { expectedVersion?: string | null; cwd?: string | null } = {},
): Promise<CodexPresetsSnapshot> {
  return requestJson(`/api/codex/presets/${encodeURIComponent(slot)}`, {
    method: "POST",
    body: JSON.stringify({ ...preset, ...options }),
  });
}
export function deleteCodexPreset(
  slot: string,
  options: { expectedVersion?: string | null; cwd?: string | null } = {},
): Promise<CodexPresetsSnapshot> {
  return requestJson(
    `/api/codex/presets/${encodeURIComponent(slot)}${query({
      expectedVersion: options.expectedVersion,
      cwd: options.cwd,
    })}`,
    { method: "DELETE" },
  );
}

// Codex account: the Codex CLI login on the Deck host, distinct from Deck's
// remote-server login. Credential fields are POSTed to the backend only.
type AccountSnapshot = import("../api/codex-account").CodexAccountSnapshot;
export function getCodexAccount(): Promise<AccountSnapshot> {
  return requestJson("/api/codex/account");
}
export function startCodexLogin(
  request: import("../api/codex-account").CodexLoginRequest,
): Promise<AccountSnapshot> {
  return requestJson("/api/codex/account/login", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
export function cancelCodexLogin(id: string | null): Promise<AccountSnapshot> {
  return requestJson("/api/codex/account/login/cancel", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}
export function logoutCodexAccount(): Promise<AccountSnapshot> {
  return requestJson("/api/codex/account/logout", {
    method: "POST",
    body: "{}",
  });
}
export function discoverCodexBedrock(): Promise<
  import("../api/codex-account").BedrockDiscovery
> {
  return requestJson("/api/codex/account/bedrock");
}
export function configureCodexBedrock(
  request: Record<string, unknown>,
): Promise<{ snapshot: AccountSnapshot; govCloudWarning: boolean }> {
  return requestJson("/api/codex/account/bedrock", {
    method: "POST",
    body: JSON.stringify(request),
  });
}
export function startCodexGatewayLogin(): Promise<AccountSnapshot> {
  return requestJson("/api/codex/account/gateway/login", {
    method: "POST",
    body: "{}",
  });
}
export function cancelCodexGatewayLogin(): Promise<AccountSnapshot> {
  return requestJson("/api/codex/account/gateway/cancel", {
    method: "POST",
    body: "{}",
  });
}

type ImportSnapshot = import("../api/codex-import").ImportSnapshot;
export function getCodexImport(): Promise<ImportSnapshot> {
  return requestJson("/api/codex/import");
}
export function detectCodexImport(
  cwd: string | null,
): Promise<import("../api/codex-import").ImportDetection> {
  return requestJson(`/api/codex/import/detect${query({ cwd })}`);
}
export function startCodexImport(
  source: string,
  items: import("../api/codex-import").ImportMigrationItem[],
  cwd: string | null,
): Promise<ImportSnapshot> {
  return requestJson("/api/codex/import", {
    method: "POST",
    body: JSON.stringify({ source, items, cwd }),
  });
}
export function dismissCodexImport(id: string): Promise<ImportSnapshot> {
  return requestJson("/api/codex/import/dismiss", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

type PluginsSnapshot = import("../api/codex-plugins").CodexPluginsSnapshot;
type PluginTarget = { pluginId: string; marketplaceName: string };
const post = <T>(url: string, payload: unknown): Promise<T> =>
  requestJson(url, { method: "POST", body: JSON.stringify(payload) });

export function getCodexApps(
  threadId: string | null,
  refresh = false,
): Promise<import("../api/codex-plugins").CodexAppsSnapshot> {
  return requestJson(
    `/api/codex/apps${query({ threadId, refresh: refresh ? "1" : null })}`,
  );
}
export function setCodexAppEnabled(
  appId: string,
  enabled: boolean,
): Promise<{ ok: boolean }> {
  return post("/api/codex/apps/enabled", { appId, enabled });
}
export function getCodexPlugins(
  cwd: string | null,
  refresh = false,
): Promise<PluginsSnapshot> {
  return requestJson(
    `/api/codex/plugins${query({ cwd, refresh: refresh ? "1" : null })}`,
  );
}
export function searchCodexPlugins(
  cwd: string | null,
  q: string,
): Promise<{ results: PluginTarget[] }> {
  return requestJson(`/api/codex/plugins/search${query({ cwd, q })}`);
}
export function readCodexPlugin(
  cwd: string | null,
  target: PluginTarget,
): Promise<import("../api/codex-plugins").CodexPluginDetailView> {
  return post("/api/codex/plugins/read", { ...target, cwd });
}
export function installCodexPlugin(
  cwd: string | null,
  target: PluginTarget,
): Promise<import("../api/codex-plugins").CodexPluginInstallResult> {
  return post("/api/codex/plugins/install", { ...target, cwd });
}
export function uninstallCodexPlugin(
  cwd: string | null,
  target: PluginTarget,
): Promise<PluginsSnapshot> {
  return post("/api/codex/plugins/uninstall", { ...target, cwd });
}
export function setCodexPluginEnabled(
  cwd: string | null,
  target: PluginTarget,
  enabled: boolean,
): Promise<PluginsSnapshot> {
  return post("/api/codex/plugins/enabled", { ...target, enabled, cwd });
}
export function addCodexMarketplace(
  cwd: string | null,
  source: string,
  refName: string | null,
): Promise<{
  snapshot: PluginsSnapshot;
  marketplaceName: string;
  alreadyAdded: boolean;
}> {
  return post("/api/codex/marketplaces/add", { source, refName, cwd });
}
export function removeCodexMarketplace(
  cwd: string | null,
  marketplaceName: string,
): Promise<PluginsSnapshot> {
  return post("/api/codex/marketplaces/remove", { marketplaceName, cwd });
}
export function upgradeCodexMarketplaces(
  cwd: string | null,
  marketplaceName: string | null,
): Promise<{
  snapshot: PluginsSnapshot;
  upgraded: string[];
  errors: { marketplaceName: string; message: string }[];
}> {
  return post("/api/codex/marketplaces/upgrade", { marketplaceName, cwd });
}
