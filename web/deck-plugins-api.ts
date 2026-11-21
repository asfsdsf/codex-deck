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
): Promise<DeckPluginRuntimeResponse> {
  return requestJson(`${pluginPath(id)}/runtime`);
}

export function getDeckPluginSource(
  id: string,
): Promise<DeckPluginSourceResponse> {
  return requestJson(`${pluginPath(id)}/source`);
}

export function getDeckPluginFileUrl(id: string, path: string): string {
  return `/api/deck-plugin-resource/${encodeURIComponent(getActiveCodexHomeId())}/${encodeURIComponent(id)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export function saveDeckPluginState(
  id: string,
  state: Record<string, unknown>,
): Promise<DeckPluginsSnapshot> {
  return requestJson(`${pluginPath(id)}/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state }),
  });
}
