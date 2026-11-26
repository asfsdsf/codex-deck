import type { DeckBuiltinPlugin } from "../types";

export const daybreakPlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.daybreak",
    name: "Daybreak",
    version: "1.0.0",
    description: "Manage eligible Daybreak access for new turns.",
    author: "Codex Deck",
    capabilities: ["services.provide"],
    entrypoints: {},
    services: {
      provides: ["codex-deck.daybreak"],
    },
    contributions: {
      views: [
        {
          id: "daybreak",
          title: "Daybreak selection",
          slot: "dialog",
        },
      ],
      commands: [
        {
          id: "daybreak",
          title: "Daybreak selection",
          description: "Manage eligible Daybreak access for new turns",
          supportsInlineArgs: false,
          requiresSession: true,
          action: {
            view: "daybreak",
          },
        },
      ],
    },
  },
  canDisable: true,
  defaultEnabled: true,
};
