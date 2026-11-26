import type {
  DeckPluginContributionsSnapshot,
  DeckPluginView,
} from "../../api/deck-plugin-manifest";
import { panePlugins } from "../../builtin-plugins/panes/manifests";
import { pluginViews } from "./contributions";

export type PaneSlot = "pane.left" | "pane.right";
export interface PaneEntry {
  key: string;
  pluginId: string;
  builtin: boolean;
  view: DeckPluginView;
}
export function paneEntryKey(
  plugin: { id: string; source?: string },
  view: DeckPluginView,
) {
  return plugin.source === "builtin"
    ? view.id
    : `plugin:${plugin.id}/${view.id}`;
}
export function paneEntries(
  plugins: DeckPluginContributionsSnapshot["plugins"],
  slot: PaneSlot | "layout.left" | "layout.right",
): PaneEntry[] {
  return pluginViews(plugins, slot).map(({ plugin, view }) => ({
    key: paneEntryKey(plugin, view),
    pluginId: plugin.id,
    builtin: plugin.source === "builtin",
    view,
  }));
}
export function activePaneLayout(
  plugins: DeckPluginContributionsSnapshot["plugins"],
  slot: "layout.left" | "layout.right",
) {
  const entries = paneEntries(plugins, slot);
  return entries.find((entry) => !entry.builtin) ?? entries[0];
}
// Keep home selection reachable while the active transport loads its catalog.
export const initialPanePlugins: DeckPluginContributionsSnapshot["plugins"] =
  panePlugins
    .filter((p) => !p.canDisable || p.manifest.id === "codex-deck.left-pane")
    .map(({ manifest }) => ({
      id: manifest.id,
      name: manifest.name,
      source: "builtin",
      contributions: manifest.contributions!,
      sessions: {},
      statuses: {},
    }));
