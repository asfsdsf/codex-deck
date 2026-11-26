import type { DeckBuiltinPlugin } from "../types";

export const recapPlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.recap",
    name: "Conversation recap",
    version: "1.0.0",
    description: "Generate and view a conversation catch-up summary.",
    author: "Codex Deck",
    capabilities: ["services.provide"],
    entrypoints: {},
    services: {
      provides: ["codex-deck.recap"],
    },
    contributions: {
      views: [
        {
          id: "recap",
          title: "Conversation recap",
          slot: "dialog",
        },
      ],
      commands: [
        {
          id: "recap",
          title: "Conversation recap",
          description: "Generate a brief conversation catch-up",
          supportsInlineArgs: false,
          requiresSession: true,
          action: {
            view: "recap",
          },
        },
      ],
    },
  },
  canDisable: true,
  defaultEnabled: true,
};
