import type {
  DeckPluginView,
  DeckPluginCommand,
} from "../../api/deck-plugin-manifest";
import type { DeckBuiltinPlugin } from "../types";

function panePlugin(
  id: string,
  name: string,
  description: string,
  slot: DeckPluginView["slot"],
  order: number,
  options: { required?: boolean; title?: string; command?: string } = {},
): DeckBuiltinPlugin {
  const commands: DeckPluginCommand[] = options.command
    ? [
        {
          id: options.command,
          title: name,
          description,
          requiresSession: true,
          action: { view: id },
        },
      ]
    : [];
  return {
    manifest: {
      schemaVersion: 1,
      id: `codex-deck.${id}`,
      name,
      description,
      version: "1.0.0",
      author: "Codex Deck",
      capabilities: [],
      entrypoints: {},
      contributions: {
        views: [{ id, title: options.title ?? name, description, slot, order }],
        commands,
      },
    },
    canDisable: !options.required,
    defaultEnabled: true,
  };
}

export const panePlugins = [
  panePlugin(
    "left-pane",
    "Left pane",
    "Project navigation and workspace views",
    "layout.left",
    0,
  ),
  panePlugin(
    "right-pane",
    "Right pane",
    "Workspace tools, tabs, and split panes",
    "layout.right",
    0,
  ),
  panePlugin(
    "terminal",
    "Terminal",
    "Open and manage interactive terminals",
    "pane.left",
    10,
  ),
  panePlugin(
    "sessions",
    "Sessions",
    "Browse and search Codex conversations",
    "pane.left",
    20,
    { required: true, title: "Codex" },
  ),
  panePlugin(
    "workflow",
    "Workflow",
    "Manage workflows and their task sessions",
    "pane.left",
    30,
  ),
  panePlugin("files", "Files", "Browse workspace files", "pane.right", 10),
  panePlugin("git", "Git", "Changes in the working tree", "pane.right", 20, {
    command: "diff",
  }),
  panePlugin(
    "tasks",
    "Tasks",
    "Subagents spawned by this session",
    "pane.right",
    30,
    { command: "ps" },
  ),
  panePlugin(
    "skills",
    "Skills",
    "Explore and manage agent capabilities",
    "pane.right",
    40,
    { command: "skills" },
  ),
  panePlugin(
    "hooks",
    "Hooks",
    "Manage automation and view executions",
    "pane.right",
    50,
    { command: "hooks" },
  ),
  panePlugin(
    "process",
    "Process",
    "Background processes and live output",
    "pane.right",
    60,
  ),
];
