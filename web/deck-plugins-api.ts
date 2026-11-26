import type {
  DeckPluginInstallInput,
  DeckPluginRuntimeResponse,
  DeckPluginSourceResponse,
  DeckPluginsSnapshot,
} from "../api/deck-plugin-manifest";
import { getActiveCodexHomeId } from "./codex-home-scope";
import { requestJson } from "./transport";

const base = "/api/deck/plugins";

function pluginPath(id: string): string {
  return `${base}/${encodeURIComponent(id)}`;
}

function scopedRequest<T>(
  url: string,
  init?: RequestInit,
  homeId = getActiveCodexHomeId(),
): Promise<T> {
  return requestJson(
    `${url}${url.includes("?") ? "&" : "?"}codexHome=${encodeURIComponent(homeId)}`,
    init,
  );
}

function post(
  url: string,
  input: unknown,
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginsSnapshot> {
  return scopedRequest(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    homeId,
  );
}

export function listDeckPlugins(
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginsSnapshot> {
  return scopedRequest(base, undefined, homeId);
}

export function installDeckPlugin(
  input: DeckPluginInstallInput,
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginsSnapshot> {
  return post(`${base}/install`, input, homeId);
}

export function setDeckPluginEnabled(
  id: string,
  enabled: boolean,
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginsSnapshot> {
  return post(`${pluginPath(id)}/enabled`, { enabled }, homeId);
}

export function uninstallDeckPlugin(
  id: string,
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginsSnapshot> {
  return scopedRequest(pluginPath(id), { method: "DELETE" }, homeId);
}

export function getDeckPluginRuntime(
  id: string,
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginRuntimeResponse> {
  return scopedRequest(`${pluginPath(id)}/runtime`, undefined, homeId);
}

export function getDeckPluginSource(
  id: string,
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginSourceResponse> {
  return scopedRequest(`${pluginPath(id)}/source`, undefined, homeId);
}

export function getDeckPluginFileUrl(
  id: string,
  path: string,
  homeId = getActiveCodexHomeId(),
): string {
  return `/api/deck-plugin-resource/${encodeURIComponent(homeId)}/${encodeURIComponent(id)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export function saveDeckPluginState(
  id: string,
  state: Record<string, unknown>,
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginsSnapshot> {
  return scopedRequest(
    `${pluginPath(id)}/state`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    },
    homeId,
  );
}

export function getDeckPluginContributions(
  homeId = getActiveCodexHomeId(),
): Promise<
  import("../api/deck-plugin-manifest").DeckPluginContributionsSnapshot
> {
  return scopedRequest(`${base}/contributions`, undefined, homeId);
}
export function setDeckPluginSessionEnabled(
  id: string,
  threadId: string,
  enabled: boolean,
  homeId = getActiveCodexHomeId(),
) {
  return scopedRequest(
    `${pluginPath(id)}/session`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, enabled }),
    },
    homeId,
  );
}
export async function requestDeckPluginWorker(
  id: string,
  method: string,
  params: unknown,
  homeId = getActiveCodexHomeId(),
  service?: string,
): Promise<unknown> {
  const { requestId } = await scopedRequest<{ requestId: string }>(
    `${pluginPath(id)}/${service ? "services" : "worker"}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params, ...(service ? { service } : {}) }),
    },
    homeId,
  );
  const deadline = Date.now() + 130_000;
  while (Date.now() < deadline) {
    const job = await scopedRequest<{
      done: boolean;
      result?: unknown;
      error?: string;
    }>(
      `${pluginPath(id)}/worker/${encodeURIComponent(requestId)}`,
      undefined,
      homeId,
    );
    if (job.done) {
      if (job.error) throw new Error(job.error);
      return job.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Plugin request timed out.");
}
export function callDeckPluginService(
  id: string,
  service: string,
  method: string,
  params: unknown,
  homeId = getActiveCodexHomeId(),
) {
  return requestDeckPluginWorker(id, method, params, homeId, service);
}
export function getDeckPluginSecretStatus(
  id: string,
  homeId = getActiveCodexHomeId(),
): Promise<Record<string, boolean>> {
  return scopedRequest(`${pluginPath(id)}/secrets`, undefined, homeId);
}
export function setDeckPluginSecrets(
  id: string,
  secrets: Record<string, string | null>,
  homeId = getActiveCodexHomeId(),
): Promise<Record<string, boolean>> {
  return scopedRequest(
    `${pluginPath(id)}/secrets`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(secrets),
    },
    homeId,
  );
}
