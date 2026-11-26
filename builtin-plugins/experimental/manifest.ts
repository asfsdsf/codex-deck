import type { DeckBuiltinPlugin } from "../types";

export const experimentalPlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.experimental",
    name: "Experimental settings",
    version: "1.0.0",
    description: "Discover and configure experimental Codex features.",
    author: "Codex Deck",
    capabilities: ["services.provide"],
    entrypoints: {},
    services: {
      provides: ["codex-deck.experimental"],
    },
    contributions: {
      views: [
        {
          id: "experimental",
          title: "Experimental features",
          slot: "dialog",
        },
      ],
      commands: [
        {
          id: "experimental",
          title: "Experimental features",
          description: "Discover and configure experimental features",
          supportsInlineArgs: false,
          requiresSession: false,
          action: {
            view: "experimental",
          },
        },
      ],
    },
  },
  canDisable: true,
  defaultEnabled: true,
};
