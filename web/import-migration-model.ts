import type {
  ImportMigrationItem,
  ImportTypeResult,
} from "../api/codex-import";

/**
 * Display helpers ported from upstream
 * codex-rs/tui/src/external_agent_config_migration/model.rs.
 */

export interface ImportGroup {
  label: string;
  description: string;
  indices: number[];
}

const ITEM_LABELS: Record<string, string> = {
  AGENTS_MD: "Instructions",
  CONFIG: "Settings",
  SKILLS: "Skills",
  PLUGINS: "Plugins",
  MCP_SERVER_CONFIG: "MCP servers",
  SUBAGENTS: "Agents",
  HOOKS: "Hooks",
  COMMANDS: "Slash commands",
  MEMORY: "Memory",
  SESSIONS: "Recent chat sessions",
};

export function importItemLabel(item: { itemType: string }): string {
  return ITEM_LABELS[item.itemType] ?? item.itemType;
}
export function importTypeLabel(itemType: string): string {
  return itemType === "SESSIONS"
    ? "Chat sessions"
    : (ITEM_LABELS[itemType] ?? itemType);
}

function list(details: Record<string, unknown> | null, key: string): unknown[] {
  const value = details?.[key];
  return Array.isArray(value) ? value : [];
}
function names(details: Record<string, unknown> | null, key: string): string[] {
  return list(details, key)
    .map((entry) =>
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).name
        : entry,
    )
    .filter((name): name is string => typeof name === "string");
}

export function importGroups(items: ImportMigrationItem[]): ImportGroup[] {
  const pick = (predicate: (item: ImportMigrationItem) => boolean) =>
    items.flatMap((item, index) => (predicate(item) ? [index] : []));
  const tools = pick((item) => !item.cwd && item.itemType !== "SESSIONS");
  const projects = pick((item) => !!item.cwd && item.itemType !== "SESSIONS");
  const sessions = pick((item) => item.itemType === "SESSIONS");
  const groups: ImportGroup[] = [];
  if (tools.length)
    groups.push({
      label: "Tools & setup",
      description:
        "Settings, instructions, integrations, agents, commands, and skills",
      indices: tools,
    });
  if (projects.length) {
    const count = new Set(projects.map((index) => items[index].cwd)).size;
    groups.push({
      label: count === 1 ? "Current project" : `Projects (${count})`,
      description: "Add Codex files alongside your existing project files",
      indices: projects,
    });
  }
  if (sessions.length) {
    const count = sessions.reduce(
      (total, index) => total + list(items[index].details, "sessions").length,
      0,
    );
    groups.push({
      label: `Chat sessions (${count})`,
      description: "Last 30 days of chats",
      indices: sessions,
    });
  }
  return groups;
}

export function importItemCount(item: ImportMigrationItem): number {
  const details = item.details;
  switch (item.itemType) {
    case "PLUGINS":
      return details
        ? list(details, "plugins").reduce<number>(
            (total, group) =>
              total +
              (Array.isArray(
                (group as Record<string, unknown> | null)?.pluginNames,
              )
                ? ((group as Record<string, unknown>).pluginNames as unknown[])
                    .length
                : 0),
            0,
          )
        : 1;
    case "MCP_SERVER_CONFIG":
      return details ? list(details, "mcpServers").length : 1;
    case "SUBAGENTS":
      return details ? list(details, "subagents").length : 1;
    case "HOOKS":
      return details ? list(details, "hooks").length : 1;
    case "COMMANDS":
      return details ? list(details, "commands").length : 1;
    case "MEMORY":
      return list(details, "memory").length;
    case "SESSIONS":
      return details ? list(details, "sessions").length : 1;
    case "SKILLS":
      return details ? list(details, "skills").length : 1;
    default:
      return 1;
  }
}

function counted(noun: string, count: number, shown: string[]): string {
  const suffix = count === 1 ? "" : "s";
  const head = shown.slice(0, 4);
  return head.length
    ? `${count} ${noun}${suffix}: ${head.join(", ")}`
    : `${count} ${noun}${suffix}`;
}

export function importItemDetail(item: ImportMigrationItem): string | null {
  const details = item.details;
  if (!details) return null;
  switch (item.itemType) {
    case "SKILLS":
      return counted(
        "skill",
        list(details, "skills").length,
        names(details, "skills"),
      );
    case "MCP_SERVER_CONFIG":
      return counted(
        "MCP server",
        list(details, "mcpServers").length,
        names(details, "mcpServers"),
      );
    case "SUBAGENTS":
      return counted(
        "agent",
        list(details, "subagents").length,
        names(details, "subagents"),
      );
    case "HOOKS":
      return counted(
        "hook",
        list(details, "hooks").length,
        names(details, "hooks"),
      );
    case "COMMANDS":
      return counted(
        "slash command",
        list(details, "commands").length,
        names(details, "commands"),
      );
    case "MEMORY": {
      const memory = names(details, "memory");
      const noun = memory.length === 1 ? "memory" : "memories";
      return memory.length
        ? `${memory.length} ${noun}: ${memory.slice(0, 4).join(", ")}`
        : `0 ${noun}`;
    }
    case "SESSIONS": {
      const sessions = list(details, "sessions");
      const titles = sessions
        .map((session) => (session as Record<string, unknown> | null)?.title)
        .filter((title): title is string => typeof title === "string");
      return counted("chat session", sessions.length, titles);
    }
    default:
      return null;
  }
}

function displayPath(path: string, cwd: string | null): string {
  if (!cwd) return path;
  const root = cwd.replace(/[\\/]+$/, "");
  if (path === root) return ".";
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)
    ? path.slice(root.length + 1)
    : path;
}

/** App-server descriptions use migration vocabulary; show import wording. */
export function importItemDescription(item: ImportMigrationItem): string {
  const description = item.description.startsWith("Migrate ")
    ? `Import ${item.description.slice("Migrate ".length)}`
    : item.description;
  if (!item.cwd) return description;
  for (const [prefix, separator] of [
    ["Import skills from ", " to "],
    ["Import ", " into "],
    ["Import ", " to "],
  ] as const) {
    if (!description.startsWith(prefix)) continue;
    const rest = description.slice(prefix.length);
    const at = rest.indexOf(separator);
    if (at < 0) continue;
    return `${prefix}${displayPath(rest.slice(0, at), item.cwd)}${separator}${displayPath(rest.slice(at + separator.length), item.cwd)}`;
  }
  return description;
}

export function importResultTotals(results: ImportTypeResult[]): {
  imported: number;
  failed: number;
} {
  return results.reduce(
    (totals, result) => ({
      imported: totals.imported + result.successes.length,
      failed: totals.failed + result.failures.length,
    }),
    { imported: 0, failed: 0 },
  );
}

export function remainingItemsHandoff(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 additional item remains. After it finishes, run /import again to review it."
    : `${count} additional items remain. After it finishes, run /import again to review them.`;
}
