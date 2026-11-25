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

function post(url: string, input: unknown): Promise<DeckPluginsSnapshot> {
  return requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function listDeckPlugins(): Promise<DeckPluginsSnapshot> {
  return requestJson(base);
}

export function installDeckPlugin(
  input: DeckPluginInstallInput,
): Promise<DeckPluginsSnapshot> {
  return post(`${base}/install`, input);
}

export function setDeckPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<DeckPluginsSnapshot> {
  return post(`${pluginPath(id)}/enabled`, { enabled });
}

export function uninstallDeckPlugin(id: string): Promise<DeckPluginsSnapshot> {
  return requestJson(pluginPath(id), { method: "DELETE" });
}

export function getDeckPluginRuntime(
  id: string,
  homeId = getActiveCodexHomeId(),
): Promise<DeckPluginRuntimeResponse> {
  return scopedRequest(`${pluginPath(id)}/runtime`, undefined, homeId);
}

export function getDeckPluginSource(
  id: string,
): Promise<DeckPluginSourceResponse> {
  return requestJson(`${pluginPath(id)}/source`);
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
): Promise<unknown> {
  const { requestId } = await scopedRequest<{ requestId: string }>(
    `${pluginPath(id)}/worker`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
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
