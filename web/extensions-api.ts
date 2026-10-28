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
