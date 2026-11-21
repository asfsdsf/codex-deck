import type {
  DeckPluginInstallInput,
  DeckPluginsSnapshot,
} from "../api/deck-plugin-manifest";
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
