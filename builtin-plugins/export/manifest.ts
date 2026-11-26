import type { DeckBuiltinPlugin } from "../types";

export const exportPlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.export",
    name: "Transcript export",
    version: "1.0.0",
    description: "Download the available conversation as Markdown.",
    author: "Codex Deck",
    capabilities: [],
    entrypoints: {},
    contributions: {
      views: [
        {
          id: "export",
          title: "Export transcript",
          slot: "dialog",
        },
      ],
      commands: [
        {
          id: "export",
          title: "Export transcript",
          description: "Export the conversation as Markdown",
          supportsInlineArgs: true,
          requiresSession: true,
          action: {
            view: "export",
          },
        },
      ],
    },
  },
  canDisable: true,
  defaultEnabled: true,
};
