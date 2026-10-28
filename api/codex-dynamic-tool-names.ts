// Shared (browser-safe) names for codex-deck's client-provided dynamic tools.
// The backend host lives in api/codex-dynamic-tools.ts.

export const CODEX_DECK_TOOL_NAMESPACE = "codex_deck";

const QUALIFIED_PREFIX = `${CODEX_DECK_TOOL_NAMESPACE}.`;

/** Conversation tool name for a Deck dynamic tool call, e.g. "codex_deck.read_thread". */
export function qualifyCodexDeckToolName(tool: string): string {
  return `${QUALIFIED_PREFIX}${tool}`;
}

/** The bare tool name of a qualified Deck tool name, or null for other tools. */
export function parseCodexDeckToolName(
  name: string | null | undefined,
): string | null {
  if (typeof name !== "string" || !name.startsWith(QUALIFIED_PREFIX)) {
    return null;
  }
  const tool = name.slice(QUALIFIED_PREFIX.length);
  return tool ? tool : null;
}
