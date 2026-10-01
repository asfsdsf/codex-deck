/** Shared field names for TOML, settings controls, and the floating tip. */
export const CONVERSATION_HOVER_FIELDS = [
  {
    key: "message_number",
    label: "Message number",
    group: "Basic",
    default: true,
  },
  { key: "timestamp", label: "Message time", group: "Basic", default: true },
  {
    key: "input_tokens",
    label: "Input tokens",
    group: "Tokens",
    default: true,
  },
  {
    key: "output_tokens",
    label: "Output tokens",
    group: "Tokens",
    default: true,
  },
  {
    key: "total_tokens",
    label: "Total tokens",
    group: "Tokens",
    default: true,
  },
  {
    key: "reasoning_tokens",
    label: "Reasoning tokens",
    group: "Tokens",
    default: true,
  },
  {
    key: "cache_read_tokens",
    label: "Cache read tokens",
    group: "Tokens",
    default: true,
  },
  {
    key: "cache_creation_tokens",
    label: "Cache creation tokens",
    group: "Tokens",
    default: true,
  },
  {
    key: "cache_hit_rate",
    label: "Cache reuse percentage",
    group: "Tokens",
    default: true,
  },
  {
    key: "context_usage",
    label: "Context usage",
    group: "Tokens",
    default: true,
  },
  { key: "model", label: "Model", group: "Model", default: false },
  {
    key: "reasoning_effort",
    label: "Reasoning effort",
    group: "Model",
    default: false,
  },
  {
    key: "service_tier",
    label: "Service tier",
    group: "Model",
    default: false,
  },
  { key: "duration", label: "Tool duration", group: "Tools", default: true },
  {
    key: "exit_code",
    label: "Command exit code",
    group: "Tools",
    default: true,
  },
  {
    key: "tool_output_tokens",
    label: "Tool output tokens",
    group: "Tools",
    default: true,
  },
  {
    key: "output_truncated",
    label: "Output truncation",
    group: "Tools",
    default: true,
  },
  {
    key: "goal_tokens",
    label: "Goal tokens used",
    group: "Goals",
    default: true,
  },
  {
    key: "goal_budget",
    label: "Goal token budget",
    group: "Goals",
    default: true,
  },
  {
    key: "goal_elapsed",
    label: "Goal elapsed time",
    group: "Goals",
    default: true,
  },
] as const;

export type ConversationHoverField =
  (typeof CONVERSATION_HOVER_FIELDS)[number]["key"];
export type ConversationHoverSettings = Record<
  ConversationHoverField | "enabled",
  boolean
>;
export type ConversationHoverConfig = Partial<ConversationHoverSettings>;

export const DEFAULT_CONVERSATION_HOVER_SETTINGS = Object.fromEntries([
  ["enabled", true],
  ...CONVERSATION_HOVER_FIELDS.map((field) => [field.key, field.default]),
]) as ConversationHoverSettings;

export function isConversationHoverSetting(
  key: string,
): key is keyof ConversationHoverSettings {
  return (
    key === "enabled" ||
    CONVERSATION_HOVER_FIELDS.some((field) => field.key === key)
  );
}

export function resolveConversationHoverSettings(
  config: ConversationHoverConfig = {},
): ConversationHoverSettings {
  const settings = { ...DEFAULT_CONVERSATION_HOVER_SETTINGS };
  for (const key of Object.keys(
    settings,
  ) as (keyof ConversationHoverSettings)[]) {
    if (typeof config[key] === "boolean") settings[key] = config[key];
  }
  return settings;
}
