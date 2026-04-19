function escapeXmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeCdata(text: string): string {
  return text.replaceAll("]]>", "]]]]><![CDATA[>");
}

export interface FrozenTerminalCommandContext {
  terminalId: string;
  transcript: string;
}

export function buildFrozenTerminalCommandOutputTag(
  input: FrozenTerminalCommandContext | null | undefined,
): string {
  const terminalId = input?.terminalId?.trim() ?? "";
  const transcript = input?.transcript?.trim() ?? "";
  if (!terminalId || !transcript) {
    return "";
  }

  return [
    "<terminal-command-output>",
    `<terminal_id>${escapeXmlText(terminalId)}</terminal_id>`,
    `<content><![CDATA[${escapeCdata(transcript)}]]></content>`,
    "</terminal-command-output>",
  ].join("\n");
}

export function buildTerminalBoundUserMessageText(input: {
  text: string;
  terminalContext?: FrozenTerminalCommandContext | null;
}): string {
  const normalizedText = input.text.trim();
  const contextTag = buildFrozenTerminalCommandOutputTag(input.terminalContext);

  if (!normalizedText) {
    return contextTag;
  }
  if (!contextTag) {
    return normalizedText;
  }

  return `${normalizedText}\n\n${contextTag}`;
}

export function buildTerminalChatBootstrapMessage(input: {
  terminalId: string;
  cwd: string;
  shell: string;
  osName: string;
  osRelease: string;
  architecture: string;
  platform: string;
  initialUserMessage: string;
  imageCount: number;
  terminalContext?: FrozenTerminalCommandContext | null;
}): string {
  const baseMessage = `(Use skill codex-deck-terminal) This chat is bound to terminal ${input.terminalId}. The controller will parse markdown replies that contain one terminal tag block such as <ai-terminal-plan>, <ai-terminal-need-input>, or <requirement_finished>. Inside <ai-terminal-plan>, you may emit multiple ordered <ai-terminal-step> blocks, but each step must contain exactly one non-interactive shell command. Wait for explicit approval before execution.`;
  const normalizedUserMessage = input.initialUserMessage.trim();
  const frozenContextTag = buildFrozenTerminalCommandOutputTag(
    input.terminalContext,
  );
  const parts = [
    baseMessage,
    "<ai-terminal-controller-context>",
    `<terminal_id>${input.terminalId}</terminal_id>`,
    `<cwd>${input.cwd}</cwd>`,
    `<shell>${input.shell}</shell>`,
    `<os_name>${input.osName}</os_name>`,
    `<os_release>${input.osRelease}</os_release>`,
    `<architecture>${input.architecture}</architecture>`,
    `<platform>${input.platform}</platform>`,
    "</ai-terminal-controller-context>",
    ...(frozenContextTag ? [frozenContextTag] : []),
  ];

  if (!normalizedUserMessage && input.imageCount === 0) {
    return parts.join("\n\n");
  }

  parts.push(
    "Treat the next section as the user's first request for this terminal chat session.",
  );
  if (input.imageCount > 0) {
    parts.push(
      `The user also attached ${input.imageCount} image${input.imageCount === 1 ? "" : "s"} in this same message. Use them as context for the first request.`,
    );
  }
  if (normalizedUserMessage) {
    parts.push(
      `User first request:\n<user-request>\n${normalizedUserMessage}\n</user-request>`,
    );
  }

  return parts.join("\n\n");
}
