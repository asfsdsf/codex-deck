export interface SlashCommandDefinition {
  name: string;
  description: string;
  supportsInlineArgs?: boolean;
  hidden?: boolean;
  aliasFor?: string;
}

export interface SlashCommandQueryState {
  commandQuery: string;
  hasArguments: boolean;
}

export interface ParsedSlashCommandInvocation {
  typedName: string;
  resolvedName: string;
  args: string;
  command: SlashCommandDefinition;
}

function normalizeCommandName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function buildCommandIndex(
  commands: SlashCommandDefinition[],
): Map<string, SlashCommandDefinition> {
  const index = new Map<string, SlashCommandDefinition>();
  for (const command of commands) {
    const normalized = normalizeCommandName(command.name);
    if (!normalized) {
      continue;
    }
    index.set(normalized, {
      ...command,
      name: normalized,
      ...(command.aliasFor
        ? { aliasFor: normalizeCommandName(command.aliasFor) }
        : {}),
    });
  }
  return index;
}

function resolveAliasName(
  commandName: string,
  index: Map<string, SlashCommandDefinition>,
): string {
  let current = commandName;
  const visited = new Set<string>();

  while (!visited.has(current)) {
    visited.add(current);
    const command = index.get(current);
    if (!command?.aliasFor) {
      return current;
    }
    current = command.aliasFor;
  }

  return current;
}

export function parseSlashCommandQuery(
  draft: string,
): SlashCommandQueryState | null {
  if (!draft.startsWith("/")) {
    return null;
  }

  const withoutPrefix = draft.slice(1);
  const firstWhitespaceIndex = withoutPrefix.search(/\s/);
  if (firstWhitespaceIndex === -1) {
    return {
      commandQuery: withoutPrefix.trim().toLowerCase(),
      hasArguments: false,
    };
  }

  return {
    commandQuery: withoutPrefix.slice(0, firstWhitespaceIndex).toLowerCase(),
    hasArguments: true,
  };
}

export function getSlashPaletteCommands(
  draft: string,
  commands: SlashCommandDefinition[],
): SlashCommandDefinition[] {
  const queryState = parseSlashCommandQuery(draft);
  if (!queryState || queryState.hasArguments) {
    return [];
  }

  const query = queryState.commandQuery;
  const visibleCommands = commands.filter(
    (command) => !command.hidden && !command.aliasFor,
  );

  if (!query) {
    return visibleCommands;
  }

  return visibleCommands.filter((command) =>
    command.name.slice(1).toLowerCase().startsWith(query),
  );
}

export function parseSlashCommandInvocation(
  draft: string,
  commands: SlashCommandDefinition[],
): ParsedSlashCommandInvocation | null {
  const trimmed = draft.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  const typedName = normalizeCommandName(match[1] ?? "");
  if (!typedName) {
    return null;
  }

  const args = (match[2] ?? "").trim();
  const index = buildCommandIndex(commands);
  const resolvedName = resolveAliasName(typedName, index);
  const command = index.get(resolvedName);
  if (!command || command.aliasFor) {
    return null;
  }

  return {
    typedName,
    resolvedName,
    args,
    command,
  };
}

export const SESSION_COMPOSER_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    name: "/model",
    description: "Choose what model and reasoning effort to use",
  },
  {
    name: "/plan",
    description: "Switch to Plan mode",
    supportsInlineArgs: true,
  },
  {
    name: "/collab",
    description: "Change collaboration mode (experimental)",
  },
  {
    name: "/status",
    description: "Show current session configuration and token usage",
  },
  {
    name: "/rename",
    description: "Rename the current thread",
    supportsInlineArgs: true,
  },
  {
    name: "/new",
    description: "Start a new chat during a conversation",
  },
  {
    name: "/clear",
    description: "Clear the terminal and start a new chat",
  },
  {
    name: "/resume",
    description: "Resume a saved chat",
  },
  {
    name: "/fork",
    description: "Fork the current chat",
  },
  {
    name: "/init",
    description: "Create an AGENTS.md file with instructions for Codex",
  },
  {
    name: "/compact",
    description: "Summarize conversation to prevent hitting the context limit",
  },
  {
    name: "/agent",
    description: "Switch the active agent thread",
  },
  {
    name: "/review",
    description: "Review my current changes and find issues",
    supportsInlineArgs: true,
  },
  {
    name: "/diff",
    description: "Show git diff (including untracked files)",
  },
  {
    name: "/copy",
    description: "Copy the latest Codex output to your clipboard",
  },
  {
    name: "/mention",
    description: "Mention a file",
  },
  {
    name: "/skills",
    description: "Use skills to improve how Codex performs specific tasks",
  },
  {
    name: "/ps",
    description: "List background terminals",
  },
  {
    name: "/clean",
    description: "Stop all background terminals",
  },
  {
    name: "/approvals",
    description: "Alias for /permissions",
    hidden: true,
    aliasFor: "/permissions",
  },
  {
    name: "/multi-agents",
    description: "Alias for /agent",
    hidden: true,
    aliasFor: "/agent",
  },
];

export function getWorkflowComposerSlashCommands(
  boundSessionId: string | null | undefined,
): SlashCommandDefinition[] {
  return typeof boundSessionId === "string" && boundSessionId.trim()
    ? SESSION_COMPOSER_SLASH_COMMANDS
    : [];
}
