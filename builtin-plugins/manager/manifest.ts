import type { DeckBuiltinPlugin } from "../types";

export const managerPlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.manager",
    name: "Plugin manager",
    version: "1.0.0",
    description: "Manage built-in and installed Deck plugins.",
    author: "Codex Deck",
    capabilities: [],
    entrypoints: {},
    contributions: {
      views: [
        {
          id: "plugins",
          title: "Plugins",
          slot: "dialog",
        },
      ],
      commands: [
        {
          id: "plugins",
          title: "Plugins",
          description: "Browse built-in and installed plugins",
          supportsInlineArgs: false,
          requiresSession: false,
          action: {
            view: "plugins",
          },
        },
      ],
    },
  },
  canDisable: false,
  defaultEnabled: true,
};
