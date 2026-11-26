import type { DeckBuiltinPlugin } from "../types";

export const usagePlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.usage",
    name: "Usage dashboard",
    version: "1.0.0",
    description: "Inspect usage, rate limits, credit estimates and resets.",
    author: "Codex Deck",
    capabilities: ["services.provide"],
    entrypoints: {},
    services: {
      provides: ["codex-deck.usage"],
    },
    contributions: {
      views: [
        {
          id: "usage",
          title: "Usage dashboard",
          slot: "dialog",
        },
      ],
      commands: [
        {
          id: "usage",
          title: "Usage dashboard",
          description: "View usage, rate limits, credit estimates, and resets",
          supportsInlineArgs: false,
          requiresSession: false,
          action: {
            view: "usage",
          },
        },
      ],
    },
  },
  canDisable: true,
  defaultEnabled: true,
};
