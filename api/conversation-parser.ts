import type {
  CodexThreadGoal,
  ContentBlock,
  ConversationMessage,
  TokenUsage,
} from "./storage";

interface LineWithOffset {
  line: string;
  offset: number;
}

interface PendingToolUse {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
  lineOffset: number;
}

export interface ConversationTextParseResult {
  messages: ConversationMessage[];
  consumedBytes: number;
  toolNames: Map<string, string>;
}

const TOOL_RESULT_MAX_LENGTH = 200_000;
const TURN_ABORTED_DEFAULT_TEXT =
  "The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.";
const TURN_ABORTED_DEFAULT_TEXT_VARIANTS = [
  TURN_ABORTED_DEFAULT_TEXT,
  "The user interrupted the previous turn on purpose. Any running unified exec processes were terminated. If any tools/commands were aborted, they may have partially executed; verify current state before retrying.",
  "This turn was interrupted before the assistant finished responding.",
];
const TURN_ABORTED_TAG_REGEX =
  /<turn_aborted>([\s\S]*?)<\/turn_aborted>|<turn_aborted\s*\/>/i;
const TOKEN_LIMIT_NOTICE_TITLE = "Rate Limit Reached";
const TOKEN_LIMIT_NOTICE_REPEAT_MAX = 6;
const TOKEN_LIMIT_NOTICE_TEXT =
  "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.";

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function getUtf8ByteLength(value: string): number {
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(value, "utf-8");
  }
  return new TextEncoder().encode(value).length;
}

function truncateToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_LENGTH) {
    return content;
  }

  const omitted = content.length - TOOL_RESULT_MAX_LENGTH;
  return `${content.slice(0, TOOL_RESULT_MAX_LENGTH)}\n... [truncated ${omitted} chars]`;
}

function toToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw: value };
  }
  if (value === undefined) {
    return {};
  }
  return { value };
}

function toToolOutputValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateToolResult(value);
  }
  if (value === undefined || value === null) {
    return "";
  }

  return value;
}

function createChatMessage(
  role: "user" | "assistant",
  content: ContentBlock[],
  uuid: string,
  timestamp?: string,
): ConversationMessage {
  return {
    type: role,
    uuid,
    timestamp,
    message: {
      role,
      content,
    },
  };
}

function createReasoningMessage(
  type: "reasoning" | "agent_reasoning",
  text: string,
  uuid: string,
  timestamp?: string,
  usage?: TokenUsage,
): ConversationMessage {
  return {
    type,
    uuid,
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type,
          text,
          ...(usage ? { token_usage: usage } : {}),
        },
      ],
    },
  };
}

function createTurnAbortedMessage(
  text: string,
  uuid: string,
  timestamp?: string,
  turnId?: string,
): ConversationMessage {
  return {
    type: "turn_aborted",
    uuid,
    turnId,
    timestamp,
    message: {
      role: "assistant",
      content: text,
    },
  };
}

function createSystemErrorMessage(
  title: string,
  text: string,
  uuid: string,
  timestamp?: string,
): ConversationMessage {
  return {
    type: "system_error",
    uuid,
    timestamp,
    summary: title,
    message: {
      role: "assistant",
      content: text,
    },
  };
}

function createTokenLimitNoticeMessage(
  uuid: string,
  timestamp?: string,
  rateLimitId?: string | null,
  repeatCount: number = 1,
): ConversationMessage {
  return {
    type: "token_limit_notice",
    uuid,
    timestamp,
    summary: TOKEN_LIMIT_NOTICE_TITLE,
    repeatCount,
    repeatCountMax: TOKEN_LIMIT_NOTICE_REPEAT_MAX,
    rateLimitId: rateLimitId ?? null,
    message: {
      role: "assistant",
      content: TOKEN_LIMIT_NOTICE_TEXT,
    },
  };
}

function createThreadGoalMessage(
  goal: CodexThreadGoal,
  uuid: string,
  timestamp?: string,
  turnId?: string,
): ConversationMessage {
  return {
    type: "thread_goal",
    uuid,
    timestamp,
    turnId,
    summary: goalStatusLabel(goal.status),
    threadGoal: goal,
    message: {
      role: "assistant",
      content: goal.objective,
    },
  };
}

function createToolMessage(
  toolUse: PendingToolUse,
  uuid: string,
  result?: { content: unknown; isError?: boolean; timestamp?: string },
): ConversationMessage {
  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: toolUse.callId,
      name: toolUse.name,
      input: toolUse.input,
      timestamp: toolUse.timestamp,
    },
  ];

  if (result) {
    content.push({
      type: "tool_result",
      tool_use_id: toolUse.callId,
      name: toolUse.name,
      content: result.content,
      is_error: result.isError,
      timestamp: result.timestamp,
    });
  }

  return {
    type: "assistant",
    uuid,
    timestamp: toolUse.timestamp ?? result?.timestamp,
    message: {
      role: "assistant",
      content,
    },
  };
}

function createToolResultOnlyMessage(
  callId: string,
  content: unknown,
  uuid: string,
  timestamp?: string,
  isError?: boolean,
  name?: string,
): ConversationMessage {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          name,
          content,
          is_error: isError,
          timestamp,
        },
      ],
    },
  };
}

function extractContentBlocksFromPayloadContent(
  content: unknown,
): ContentBlock[] {
  if (typeof content === "string") {
    return content.trim()
      ? [
          {
            type: "text",
            text: content,
          },
        ]
      : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: ContentBlock[] = [];
  const imageTagOnlyTextRegex = /^<\/?image\b[^>]*>$/i;

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const block = item as {
      type?: unknown;
      text?: unknown;
      image_url?: unknown;
      imageUrl?: unknown;
    };

    if (
      (block.type === "input_text" || block.type === "output_text") &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
    ) {
      if (imageTagOnlyTextRegex.test(block.text.trim())) {
        continue;
      }
      blocks.push({
        type: "text",
        text: block.text,
      });
      continue;
    }

    if (block.type === "input_image") {
      const imageUrl =
        typeof block.image_url === "string"
          ? block.image_url
          : typeof block.imageUrl === "string"
            ? block.imageUrl
            : "";
      if (imageUrl.trim().length > 0) {
        blocks.push({
          type: "image",
          image_url: imageUrl,
        });
      }
    }
  }

  return blocks;
}

function extractTextFromReasoningParts(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextFromReasoningParts(item))
      .filter(Boolean);
    return parts.join("\n\n").trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    summary?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text.trim();
  }

  if (record.summary !== undefined) {
    const summaryText = extractTextFromReasoningParts(record.summary);
    if (summaryText) {
      return summaryText;
    }
  }

  if (record.content !== undefined) {
    return extractTextFromReasoningParts(record.content);
  }

  return "";
}

function extractReasoningText(payload: Record<string, unknown>): string {
  const summaryText = extractTextFromReasoningParts(payload.summary);
  if (summaryText) {
    return summaryText;
  }

  return extractTextFromReasoningParts(payload.content);
}

function normalizeReasoningText(text: string): string {
  const trimmed = text.trim();
  const unwrapped = trimmed.replace(/^\*\*(.*?)\*\*$/s, "$1");
  return unwrapped.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isDefaultTurnAbortedText(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return TURN_ABORTED_DEFAULT_TEXT_VARIANTS.some(
    (variant) => normalizeComparableText(variant) === normalized,
  );
}

function extractTurnAbortedText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(TURN_ABORTED_TAG_REGEX);
  if (!match) {
    return null;
  }

  const content = match[1].trim();
  return content || TURN_ABORTED_DEFAULT_TEXT;
}

function getReasoningTextFromMessage(
  message: ConversationMessage,
): string | null {
  if (message.type !== "reasoning" && message.type !== "agent_reasoning") {
    return null;
  }

  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const block = content.find(
    (item) => item.type === "reasoning" || item.type === "agent_reasoning",
  );

  return typeof block?.text === "string" ? block.text : null;
}

function getTurnAbortedTextFromMessage(
  message: ConversationMessage,
): string | null {
  if (message.type !== "turn_aborted") {
    return null;
  }

  const content = message.message?.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || null;
  }

  if (Array.isArray(content)) {
    const textBlock = content.find(
      (item) => item.type === "text" && typeof item.text === "string",
    );
    const text =
      typeof textBlock?.text === "string" ? textBlock.text.trim() : "";
    return text || null;
  }

  return null;
}

function getSystemErrorComparableText(
  message: ConversationMessage,
): string | null {
  if (message.type !== "system_error") {
    return null;
  }

  const title =
    typeof message.summary === "string" ? message.summary.trim() : "";
  const content = message.message?.content;
  const text =
    typeof content === "string"
      ? content.trim()
      : Array.isArray(content)
        ? content
            .filter(
              (item) => item.type === "text" && typeof item.text === "string",
            )
            .map((item) => item.text?.trim() ?? "")
            .filter(Boolean)
            .join("\n")
        : "";
  const combined = [title, text].filter(Boolean).join("\n").trim();
  return combined || null;
}

function getTokenLimitNoticeComparableKey(
  message: ConversationMessage,
): string | null {
  if (message.type !== "token_limit_notice") {
    return null;
  }

  const rateLimitId =
    typeof message.rateLimitId === "string" ? message.rateLimitId.trim() : "";
  return rateLimitId || "token-limit-notice";
}

function getMostRecentVisibleMessageIndex(
  messages: ConversationMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      candidate.type === "task_started" ||
      candidate.type === "task_complete"
    ) {
      continue;
    }
    return index;
  }

  return -1;
}

function normalizeThreadGoalComparableKey(
  message: ConversationMessage,
): string | null {
  if (message.type !== "thread_goal" || !message.threadGoal) {
    return null;
  }
  const goal = message.threadGoal;
  return [
    goal.threadId,
    goal.objective.trim(),
    goal.status,
    goal.tokenBudget ?? "",
    goal.tokensUsed,
    goal.timeUsedSeconds,
  ].join("\u0000");
}

function pushConversationMessage(
  messages: ConversationMessage[],
  message: ConversationMessage,
): void {
  if (message.type === "reasoning" || message.type === "agent_reasoning") {
    const text = getReasoningTextFromMessage(message);
    const lastMessage = messages[messages.length - 1];
    const lastText = lastMessage
      ? getReasoningTextFromMessage(lastMessage)
      : null;

    if (
      text &&
      lastText &&
      normalizeReasoningText(text) === normalizeReasoningText(lastText)
    ) {
      return;
    }
  }

  if (message.type === "turn_aborted") {
    const text = getTurnAbortedTextFromMessage(message);
    const lastVisibleMessageIndex = getMostRecentVisibleMessageIndex(messages);
    const lastMessage =
      lastVisibleMessageIndex >= 0
        ? messages[lastVisibleMessageIndex]
        : undefined;
    const lastText = lastMessage
      ? getTurnAbortedTextFromMessage(lastMessage)
      : null;

    if (lastMessage?.type === "turn_aborted") {
      if (!text || !lastText) {
        return;
      }

      if (normalizeComparableText(text) === normalizeComparableText(lastText)) {
        return;
      }

      if (isDefaultTurnAbortedText(text)) {
        return;
      }

      if (isDefaultTurnAbortedText(lastText)) {
        messages[lastVisibleMessageIndex] = message;
        return;
      }

      return;
    }
  }

  if (message.type === "system_error") {
    const text = getSystemErrorComparableText(message);
    const lastMessage = messages[messages.length - 1];
    const lastText = lastMessage
      ? getSystemErrorComparableText(lastMessage)
      : null;

    if (
      text &&
      lastText &&
      normalizeComparableText(text) === normalizeComparableText(lastText)
    ) {
      return;
    }
  }

  if (message.type === "token_limit_notice") {
    const lastMessage = messages[messages.length - 1];
    const lastKey = lastMessage
      ? getTokenLimitNoticeComparableKey(lastMessage)
      : null;
    const nextKey = getTokenLimitNoticeComparableKey(message);

    if (
      lastMessage?.type === "token_limit_notice" &&
      nextKey &&
      lastKey === nextKey
    ) {
      messages[messages.length - 1] = {
        ...lastMessage,
        ...message,
        uuid: message.uuid ?? lastMessage.uuid,
        timestamp: message.timestamp ?? lastMessage.timestamp,
        repeatCount:
          (lastMessage.repeatCount ?? 1) + (message.repeatCount ?? 1),
        repeatCountMax: message.repeatCountMax ?? lastMessage.repeatCountMax,
        rateLimitId: message.rateLimitId ?? lastMessage.rateLimitId ?? null,
      };
      return;
    }
  }

  if (message.type === "thread_goal") {
    const lastMessage = messages[messages.length - 1];
    const lastKey = lastMessage
      ? normalizeThreadGoalComparableKey(lastMessage)
      : null;
    const nextKey = normalizeThreadGoalComparableKey(message);
    if (lastMessage?.type === "thread_goal" && nextKey && nextKey === lastKey) {
      messages[messages.length - 1] = {
        ...lastMessage,
        ...message,
        uuid: message.uuid ?? lastMessage.uuid,
        timestamp: message.timestamp ?? lastMessage.timestamp,
      };
      return;
    }
  }

  messages.push(message);
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asNullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return asFiniteNumber(value);
}

function parseLastTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const inputTokens = asFiniteNumber(record.input_tokens);
  const outputTokens = asFiniteNumber(record.output_tokens);
  if (inputTokens === null || outputTokens === null) {
    return undefined;
  }

  const totalTokens = asFiniteNumber(record.total_tokens);
  const reasoningOutputTokens = asFiniteNumber(record.reasoning_output_tokens);
  const cacheCreationInputTokens = asFiniteNumber(
    record.cache_creation_input_tokens,
  );
  const cacheReadInputTokens =
    asFiniteNumber(record.cache_read_input_tokens) ??
    asFiniteNumber(record.cached_input_tokens);

  return {
    input_tokens: Math.max(0, Math.round(inputTokens)),
    output_tokens: Math.max(0, Math.round(outputTokens)),
    ...(totalTokens !== null
      ? { total_tokens: Math.max(0, Math.round(totalTokens)) }
      : {}),
    ...(reasoningOutputTokens !== null
      ? {
          reasoning_output_tokens: Math.max(
            0,
            Math.round(reasoningOutputTokens),
          ),
        }
      : {}),
    ...(cacheCreationInputTokens !== null
      ? {
          cache_creation_input_tokens: Math.max(
            0,
            Math.round(cacheCreationInputTokens),
          ),
        }
      : {}),
    ...(cacheReadInputTokens !== null
      ? {
          cache_read_input_tokens: Math.max(
            0,
            Math.round(cacheReadInputTokens),
          ),
        }
      : {}),
  };
}

function attachTokenUsageToLatestReasoning(
  messages: ConversationMessage[],
  usage: TokenUsage,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === "user") {
      return;
    }
    if (message.type !== "reasoning" && message.type !== "agent_reasoning") {
      continue;
    }
    if (!Array.isArray(message.message?.content)) {
      continue;
    }
    const block = message.message.content.find(
      (item) => item.type === message.type,
    );
    if (!block || block.token_usage) {
      return;
    }
    block.token_usage = usage;
    return;
  }
}

function goalStatusLabel(status: CodexThreadGoal["status"]): string {
  if (status === "usageLimited") {
    return "Usage Limited";
  }
  if (status === "budgetLimited") {
    return "Budget Limited";
  }
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

function parseThreadGoalFromPayload(
  payload: Record<string, unknown>,
): CodexThreadGoal | null {
  const goalValue = payload.goal;
  if (!goalValue || typeof goalValue !== "object" || Array.isArray(goalValue)) {
    return null;
  }

  const goal = goalValue as Record<string, unknown>;
  const threadId = asTrimmedString(goal.threadId ?? goal.thread_id);
  const objective = asTrimmedString(goal.objective);
  const status = asTrimmedString(goal.status);
  const tokensUsed = asFiniteNumber(goal.tokensUsed ?? goal.tokens_used);
  const timeUsedSeconds = asFiniteNumber(
    goal.timeUsedSeconds ?? goal.time_used_seconds,
  );
  const createdAt = asFiniteNumber(goal.createdAt ?? goal.created_at);
  const updatedAt = asFiniteNumber(goal.updatedAt ?? goal.updated_at);
  if (
    !threadId ||
    !objective ||
    (status !== "active" &&
      status !== "paused" &&
      status !== "blocked" &&
      status !== "usageLimited" &&
      status !== "budgetLimited" &&
      status !== "complete") ||
    tokensUsed === null ||
    timeUsedSeconds === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }

  const tokenBudget = asNullableFiniteNumber(
    goal.tokenBudget ?? goal.token_budget,
  );
  return {
    threadId,
    objective,
    status,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}

function parseToolUseFromPayload(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  offset: number,
): PendingToolUse {
  const payloadType = typeof payload.type === "string" ? payload.type : "";

  let input: Record<string, unknown> = {};
  if (payloadType === "function_call") {
    input = toToolInput(payload.arguments);
  } else if (payloadType === "custom_tool_call") {
    input = toToolInput(payload.input);
  } else if (payloadType === "web_search_call") {
    input = toToolInput(payload.action);
  }

  const name =
    payloadType === "web_search_call"
      ? "web_search"
      : typeof payload.name === "string"
        ? payload.name
        : "unknown_tool";

  const callId =
    typeof payload.call_id === "string" && payload.call_id
      ? payload.call_id
      : `${name}-${offset}`;

  return {
    callId,
    name,
    input,
    timestamp,
    lineOffset: offset,
  };
}

function parseToolResultFromPayload(payload: Record<string, unknown>): {
  callId: string;
  content: unknown;
  isError?: boolean;
} {
  const callId =
    typeof payload.call_id === "string" && payload.call_id
      ? payload.call_id
      : `unknown-call-${Date.now()}`;

  const isError =
    typeof payload.is_error === "boolean"
      ? payload.is_error
      : typeof payload.error === "boolean"
        ? payload.error
        : undefined;

  return {
    callId,
    content: toToolOutputValue(payload.output),
    isError,
  };
}

function parseCodexConversation(
  lines: LineWithOffset[],
  knownToolNames?: Map<string, string>,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const pendingToolCalls = new Map<string, PendingToolUse>();
  const pendingToolMessageIndexes = new Map<string, number>();
  const toolNames = knownToolNames ?? new Map<string, string>();

  for (const { line, offset } of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const record = parsed as {
      type?: unknown;
      timestamp?: unknown;
      payload?: unknown;
    };
    const timestamp =
      typeof record.timestamp === "string" ? record.timestamp : undefined;

    if (!record.payload || typeof record.payload !== "object") {
      continue;
    }

    const payload = record.payload as Record<string, unknown>;
    const payloadType = typeof payload.type === "string" ? payload.type : "";

    if (record.type === "event_msg") {
      if (payloadType === "thread_goal_updated") {
        const goal = parseThreadGoalFromPayload(payload);
        if (!goal) {
          continue;
        }
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
        pushConversationMessage(
          messages,
          createThreadGoalMessage(
            goal,
            `${offset}:thread-goal:${messages.length}`,
            timestamp,
            turnId || undefined,
          ),
        );
        continue;
      }

      if (payloadType === "turn_aborted") {
        const reason =
          typeof payload.reason === "string" ? payload.reason.trim() : "";
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
        const text =
          reason === "interrupted" || !reason
            ? TURN_ABORTED_DEFAULT_TEXT
            : `Turn aborted (${reason}). ${TURN_ABORTED_DEFAULT_TEXT}`;

        pushConversationMessage(
          messages,
          createTurnAbortedMessage(
            text,
            `${offset}:turn-aborted-event:${messages.length}`,
            timestamp,
            turnId || undefined,
          ),
        );
        continue;
      }

      if (payloadType === "error") {
        const text =
          typeof payload.message === "string" ? payload.message.trim() : "";
        if (!text) {
          continue;
        }

        pushConversationMessage(
          messages,
          createSystemErrorMessage(
            "Error",
            text,
            `${offset}:system-error:${messages.length}`,
            timestamp,
          ),
        );
        continue;
      }

      if (
        payloadType === "token_count" &&
        payload.info &&
        typeof payload.info === "object"
      ) {
        const usage = parseLastTokenUsage(
          (payload.info as Record<string, unknown>).last_token_usage,
        );
        if (usage) {
          attachTokenUsageToLatestReasoning(messages, usage);
        }
        continue;
      }

      if (
        payloadType === "token_count" &&
        payload.info == null &&
        payload.rate_limits &&
        typeof payload.rate_limits === "object"
      ) {
        const rateLimitId =
          typeof (payload.rate_limits as Record<string, unknown>).limit_id ===
          "string"
            ? (
                (payload.rate_limits as Record<string, unknown>)
                  .limit_id as string
              ).trim()
            : null;

        pushConversationMessage(
          messages,
          createTokenLimitNoticeMessage(
            `${offset}:token-limit-notice:${messages.length}`,
            timestamp,
            rateLimitId,
          ),
        );
        continue;
      }

      if (
        payloadType === "context_compacted" ||
        payloadType === "contextCompacted"
      ) {
        pushConversationMessage(
          messages,
          createChatMessage(
            "assistant",
            [
              {
                type: "text",
                text: "Context compacted",
              },
            ],
            `${offset}:context-compacted:${messages.length}`,
            timestamp,
          ),
        );
        continue;
      }

      if (payloadType === "task_started") {
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
        pushConversationMessage(messages, {
          type: "task_started",
          uuid: `${offset}:task-started:${messages.length}`,
          turnId: turnId || undefined,
          timestamp,
        });
        continue;
      }

      if (payloadType === "task_complete") {
        const turnId =
          typeof payload.turn_id === "string" ? payload.turn_id.trim() : "";
        pushConversationMessage(messages, {
          type: "task_complete",
          uuid: `${offset}:task-complete:${messages.length}`,
          turnId: turnId || undefined,
          timestamp,
        });
        continue;
      }

      if (payloadType !== "agent_reasoning") {
        continue;
      }

      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        continue;
      }

      pushConversationMessage(
        messages,
        createReasoningMessage(
          "agent_reasoning",
          text,
          `${offset}:agent-reasoning:${messages.length}`,
          timestamp,
        ),
      );
      continue;
    }

    if (record.type !== "response_item") {
      continue;
    }

    if (payloadType === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }

      const content = extractContentBlocksFromPayloadContent(payload.content);
      if (content.length === 0) {
        continue;
      }

      const text = content
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text ?? "")
        .join("\n\n")
        .trim();
      const turnAbortedText =
        role === "user" ? extractTurnAbortedText(text) : null;
      if (turnAbortedText) {
        pushConversationMessage(
          messages,
          createTurnAbortedMessage(
            turnAbortedText,
            `${offset}:turn-aborted-message:${messages.length}`,
            timestamp,
          ),
        );
        continue;
      }

      pushConversationMessage(
        messages,
        createChatMessage(
          role,
          content,
          `${offset}:message:${messages.length}`,
          timestamp,
        ),
      );
      continue;
    }

    if (payloadType === "reasoning") {
      let text = extractReasoningText(payload);
      if (!text) {
        const hasEncryptedContent =
          typeof payload.encrypted_content === "string" &&
          payload.encrypted_content.trim().length > 0;
        if (!hasEncryptedContent) {
          continue;
        }
        text = "Encrypted reasoning captured in the session log";
      }

      pushConversationMessage(
        messages,
        createReasoningMessage(
          "reasoning",
          text,
          `${offset}:reasoning:${messages.length}`,
          timestamp,
          parseLastTokenUsage(payload.last_token_usage),
        ),
      );
      continue;
    }

    if (
      payloadType === "function_call" ||
      payloadType === "custom_tool_call" ||
      payloadType === "web_search_call"
    ) {
      const toolUse = parseToolUseFromPayload(payload, timestamp, offset);
      pendingToolCalls.set(toolUse.callId, toolUse);
      toolNames.set(toolUse.callId, toolUse.name);
      pushConversationMessage(
        messages,
        createToolMessage(toolUse, `${offset}:tool:${messages.length}`),
      );
      pendingToolMessageIndexes.set(toolUse.callId, messages.length - 1);

      if (payloadType === "web_search_call" && payload.status !== undefined) {
        const messageIndex = pendingToolMessageIndexes.get(toolUse.callId);
        const messageUuid =
          typeof messageIndex === "number" &&
          messageIndex >= 0 &&
          messageIndex < messages.length
            ? (messages[messageIndex]?.uuid ??
              `${offset}:tool:${messages.length}`)
            : `${offset}:tool:${messages.length}`;
        const completedMessage = createToolMessage(toolUse, messageUuid, {
          content: toToolOutputValue(payload.status),
        });
        if (
          typeof messageIndex === "number" &&
          messageIndex >= 0 &&
          messageIndex < messages.length
        ) {
          messages[messageIndex] = completedMessage;
        } else {
          pushConversationMessage(messages, completedMessage);
        }
        pendingToolCalls.delete(toolUse.callId);
        pendingToolMessageIndexes.delete(toolUse.callId);
      }
      continue;
    }

    if (
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output"
    ) {
      const result = parseToolResultFromPayload(payload);
      const pairedToolUse = pendingToolCalls.get(result.callId);
      const toolName = pairedToolUse?.name ?? toolNames.get(result.callId);

      if (pairedToolUse) {
        const messageIndex = pendingToolMessageIndexes.get(result.callId);
        const messageUuid =
          typeof messageIndex === "number" &&
          messageIndex >= 0 &&
          messageIndex < messages.length
            ? (messages[messageIndex]?.uuid ??
              `${offset}:tool-pair:${messages.length}`)
            : `${offset}:tool-pair:${messages.length}`;
        const completedMessage = createToolMessage(pairedToolUse, messageUuid, {
          content: result.content,
          isError: result.isError,
          timestamp,
        });
        if (
          typeof messageIndex === "number" &&
          messageIndex >= 0 &&
          messageIndex < messages.length
        ) {
          messages[messageIndex] = completedMessage;
        } else {
          pushConversationMessage(messages, completedMessage);
        }
        pendingToolCalls.delete(result.callId);
        pendingToolMessageIndexes.delete(result.callId);
      } else {
        pushConversationMessage(
          messages,
          createToolResultOnlyMessage(
            result.callId,
            result.content,
            `${offset}:tool-result:${messages.length}`,
            timestamp,
            result.isError,
            toolName,
          ),
        );
      }
      continue;
    }
  }

  return messages;
}

function collectCompleteConversationLines(
  text: string,
  startOffset: number,
): { lines: LineWithOffset[]; consumedBytes: number } {
  const lines: LineWithOffset[] = [];
  let consumedBytes = 0;
  let currentOffset = startOffset;
  let cursor = 0;

  while (cursor < text.length) {
    const newlineIndex = text.indexOf("\n", cursor);
    const hasNewline = newlineIndex !== -1;
    const lineEnd = hasNewline ? newlineIndex : text.length;
    const line = text.slice(cursor, lineEnd);
    const lineBytes = getUtf8ByteLength(line) + (hasNewline ? 1 : 0);

    if (line.trim()) {
      const parsed = safeJsonParse(line);
      if (parsed === null) {
        break;
      }

      lines.push({
        line,
        offset: currentOffset,
      });
    }

    consumedBytes += lineBytes;
    currentOffset += lineBytes;

    if (!hasNewline) {
      break;
    }

    cursor = newlineIndex + 1;
  }

  return {
    lines,
    consumedBytes,
  };
}

export function parseConversationTextChunk(
  text: string,
  startOffset: number = 0,
  knownToolNames?: Map<string, string>,
): ConversationTextParseResult {
  const { lines, consumedBytes } = collectCompleteConversationLines(
    text,
    startOffset,
  );
  const toolNames = knownToolNames ?? new Map<string, string>();

  return {
    messages: parseCodexConversation(lines, toolNames),
    consumedBytes,
    toolNames,
  };
}
