export const TERMINAL_RESTART_BOUND_SESSION_NOTICE =
  "Terminal context notice: The terminal session was restarted. Shell state such as environment variables, aliases, and running processes may have been lost. Do not respond to or act on this notice.";
export const TERMINAL_RESTART_NOTICE_TAG = "terminal-restart-message";
const TERMINAL_RESTART_NOTICE_BLOCK_PATTERN = new RegExp(
  `<${TERMINAL_RESTART_NOTICE_TAG}>\\s*([\\s\\S]*?)\\s*<\\/${TERMINAL_RESTART_NOTICE_TAG}>`,
  "i",
);

type RestartNoticePayload = {
  text: string;
  images: string[];
};

type RestartNoticeOptions = {
  sessionIdOverride: string;
  cwdOverride: string | null;
};

export interface ParsedTerminalRestartNoticeMessage {
  notice: string;
  leadingMarkdown: string;
  trailingMarkdown: string;
  rawBlock: string;
}

export function buildTerminalRestartNoticeTag(): string {
  return `<${TERMINAL_RESTART_NOTICE_TAG}>${TERMINAL_RESTART_BOUND_SESSION_NOTICE}</${TERMINAL_RESTART_NOTICE_TAG}>`;
}

export function prependTerminalRestartNoticeToMessage(text: string): string {
  const normalizedText = text.trim();
  const prefix = buildTerminalRestartNoticeTag();
  return normalizedText ? `${prefix}\n\n${normalizedText}` : prefix;
}

export function parseTerminalRestartNoticeMessage(
  text: string,
): ParsedTerminalRestartNoticeMessage | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(TERMINAL_RESTART_NOTICE_BLOCK_PATTERN);
  if (!match) {
    return null;
  }

  const rawBlock = match[0]?.trim() ?? "";
  const notice = match[1]?.trim() ?? "";
  if (!rawBlock || !notice) {
    return null;
  }

  const startIndex = match.index ?? 0;
  const leadingMarkdown = normalized.slice(0, startIndex).trim();
  const trailingMarkdown = normalized
    .slice(startIndex + rawBlock.length)
    .trim();

  return {
    notice,
    leadingMarkdown,
    trailingMarkdown,
    rawBlock,
  };
}

export async function sendTerminalRestartNoticeToBoundSession(input: {
  boundSessionId?: string | null;
  cwd?: string | null;
  sendMessage: (
    payload: RestartNoticePayload,
    options: RestartNoticeOptions,
  ) => Promise<boolean>;
}): Promise<boolean> {
  const sessionId = input.boundSessionId?.trim();
  if (!sessionId) {
    return false;
  }

  return input.sendMessage(
    {
      text: buildTerminalRestartNoticeTag(),
      images: [],
    },
    {
      sessionIdOverride: sessionId,
      cwdOverride: input.cwd?.trim() || null,
    },
  );
}
