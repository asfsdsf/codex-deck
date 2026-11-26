import type { DeckPluginManifest } from "../api/deck-plugin-manifest";

export interface DeckBuiltinPlugin {
  manifest: DeckPluginManifest;
  canDisable: boolean;
  defaultEnabled: boolean;
}
