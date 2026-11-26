import type { DeckBuiltinPlugin } from "../types";

export const translationPlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.translation",
    name: "Translation",
    version: "1.0.0",
    description:
      "Translate conversation text using the configured translation backend.",
    author: "Codex Deck",
    capabilities: ["services.provide"],
    entrypoints: {},
    services: {
      provides: ["codex-deck.translation"],
    },
  },
  canDisable: true,
  defaultEnabled: true,
};
