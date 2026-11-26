import type { DeckBuiltinPlugin } from "../types";

export const memoryPlugin: DeckBuiltinPlugin = {
  manifest: {
    schemaVersion: 1,
    id: "codex-deck.memory",
    name: "Memory insights",
    version: "1.0.0",
    description: "Inspect memory readiness and conversation memory summaries.",
    author: "Codex Deck",
    capabilities: ["services.provide"],
    entrypoints: {},
    services: {
      provides: ["codex-deck.memory"],
    },
    contributions: {
      views: [
        {
          id: "insights-inline",
          title: "Memory insights",
          slot: "memory.settings",
        },
        {
          id: "memory-insights",
          title: "Memory insights",
          slot: "dialog",
        },
      ],
      commands: [
        {
          id: "memory-insights",
          title: "Memory insights",
          description: "Inspect memory readiness and conversation summaries",
          supportsInlineArgs: false,
          requiresSession: false,
          action: {
            view: "memory-insights",
          },
        },
      ],
    },
  },
  canDisable: true,
  defaultEnabled: true,
};
