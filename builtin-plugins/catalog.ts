import { managerPlugin } from "./manager/manifest";
import { panePlugins } from "./panes/manifests";
import { parseDeckPluginManifest } from "../api/deck-plugin-manifest";
import { diagnosticsPlugin } from "./diagnostics/manifest";
import { daybreakPlugin } from "./daybreak/manifest";
import { experimentalPlugin } from "./experimental/manifest";
import { exportPlugin } from "./export/manifest";
import { recapPlugin } from "./recap/manifest";
import { usagePlugin } from "./usage/manifest";
import { translationPlugin } from "./translation/manifest";
import { memoryPlugin } from "./memory/manifest";

/** Shared metadata only; never imports server code into the browser. */
export const DECK_BUILTIN_PLUGINS = [
  managerPlugin,
  ...panePlugins,
  diagnosticsPlugin,
  daybreakPlugin,
  experimentalPlugin,
  exportPlugin,
  recapPlugin,
  usagePlugin,
  translationPlugin,
  memoryPlugin,
];

for (const plugin of DECK_BUILTIN_PLUGINS) {
  plugin.manifest = parseDeckPluginManifest(plugin.manifest, { builtin: true });
  if (!plugin.canDisable && !plugin.defaultEnabled)
    throw new Error(
      `Required built-in plugin ${plugin.manifest.id} must be enabled.`,
    );
}
