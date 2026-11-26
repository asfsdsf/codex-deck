import type { DeckBuiltinPlugin } from "../types";

export const diagnosticsPlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.diagnostics",
    name: "Diagnostics",
    version: "1.0.0",
    description: "Inspect retained warnings and configuration value origins.",
    author: "Codex Deck",
    capabilities: ["services.provide"],
    entrypoints: {},
    services: {
      provides: ["codex-deck.diagnostics"],
    },
    contributions: {
      views: [
        {
          id: "warnings",
          title: "Retained warnings",
          slot: "dialog",
        },
        {
          id: "debug-config",
          title: "Configuration diagnostics",
          slot: "dialog",
        },
      ],
      commands: [
        {
          id: "warnings",
          title: "Retained warnings",
          description: "Read retained configuration warnings and deprecations",
          supportsInlineArgs: false,
          requiresSession: false,
          action: {
            view: "warnings",
          },
        },
        {
          id: "debug-config",
          title: "Configuration diagnostics",
          description:
            "Inspect configuration layers, value origins, and requirements",
          supportsInlineArgs: false,
          requiresSession: false,
          action: {
            view: "debug-config",
          },
        },
      ],
    },
  },
  canDisable: true,
  defaultEnabled: true,
};
