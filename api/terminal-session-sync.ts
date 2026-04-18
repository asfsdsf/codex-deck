import type { ConversationMessage, TerminalSessionArtifactsResponse } from "./storage";
import { getConversation } from "./storage";
import {
  getPersistedTerminalSessionArtifacts,
  persistTerminalSessionFrozenBlock,
} from "./terminal-session-store";
import {
  extractConversationMessageText,
  getAiTerminalMessageKey,
  parseAiTerminalMessage,
} from "../web/ai-terminal";
import {
  buildTerminalTimelineEntries,
  sanitizeTerminalTranscriptChunk,
} from "./terminal-transcript";

const lastArtifactsPayloadByTerminalId = new Map<string, string>();

interface EmbeddedTerminalMessage {
  messageKey: string;
  message: ConversationMessage;
}

function isTerminalCompletionMessage(message: ConversationMessage): boolean {
  const parsed = parseAiTerminalMessage(extractConversationMessageText(message));
  return parsed?.directive.kind === "finished";
}

function listEmbeddedTerminalMessages(
  sessionId: string,
  messages: ConversationMessage[],
): EmbeddedTerminalMessage[] {
  return messages
    .filter((message) => {
      if (message.type !== "assistant") {
        return false;
      }
      return parseAiTerminalMessage(extractConversationMessageText(message)) !== null;
    })
    .map((message, index) => ({
      messageKey: getAiTerminalMessageKey(message) ?? `terminal-ai:${sessionId}:${index}`,
      message,
    }));
}

function shouldFreezeTerminalTranscript(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  const lines = normalized
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return false;
  }
  if (lines.length > 1) {
    return true;
  }
  return !(
    /[#$%>»]$/.test(normalized) &&
    (normalized.includes("/") ||
      normalized.includes("~") ||
      normalized.startsWith("(") ||
      normalized.startsWith("["))
  );
}

function stripPrefix(output: string, prefix: string): string {
  if (!prefix) {
    return output;
  }
  if (output.startsWith(prefix)) {
    return output.slice(prefix.length);
  }
  const trimmedPrefix = prefix.trim();
  if (trimmedPrefix && output.startsWith(trimmedPrefix)) {
    return output.slice(trimmedPrefix.length);
  }
  return output;
}

function deriveTranscriptTail(input: {
  output: string;
  orderedKnownTranscripts: string[];
}): string {
  let remaining = input.output;
  for (const transcript of input.orderedKnownTranscripts) {
    remaining = stripPrefix(remaining, transcript);
  }
  return remaining.trim();
}

export function buildEmptyTerminalSessionArtifacts(
  terminalId: string,
): TerminalSessionArtifactsResponse {
  const timestamp = new Date().toISOString();
  return {
    terminalId,
    sessionId: null,
    manifest: {
      terminalId,
      createdAt: timestamp,
      updatedAt: timestamp,
      blocks: [],
    },
    blocks: [],
    timelineEntries: [],
  };
}

export async function syncTerminalSessionArtifacts(input: {
  terminalId: string;
  sessionId: string;
  output: string;
  codexHome?: string | null;
  viewport?: {
    cols: number;
    rows: number;
  } | null;
}): Promise<TerminalSessionArtifactsResponse> {
  const messages = await getConversation(input.sessionId);
  const embeddedMessages = listEmbeddedTerminalMessages(input.sessionId, messages);
  const persistedArtifacts = await getPersistedTerminalSessionArtifacts(
    input.terminalId,
    { sessionId: input.sessionId },
    input.codexHome,
  );

  const persistedByLogicalKey = new Map<string, TerminalSessionArtifactsResponse["blocks"][number]>(
    persistedArtifacts.blocks.map((block) => [
      `${block.kind}:${block.sessionId}:${block.messageKey ?? ""}:${block.stepId ?? ""}`,
      block,
    ] as const),
  );
  const output = sanitizeTerminalTranscriptChunk(input.output).trim();
  const orderedKnownTranscripts: string[] = [];

  for (const [index, item] of embeddedMessages.entries()) {
    const kind = isTerminalCompletionMessage(item.message) ? "execution" : "manual";
    const logicalKey = `${kind}:${input.sessionId}:${item.messageKey}:`;
    const existing = persistedByLogicalKey.get(logicalKey);
    const sequence = index + 1;
    const existingTranscript = existing?.transcript?.trim() || "";

    if (existingTranscript) {
      orderedKnownTranscripts.push(existingTranscript);
    }

    const needsSequenceUpdate =
      existing && (existing.sequence !== sequence || existing.kind !== kind);
    if (existingTranscript && needsSequenceUpdate) {
      await persistTerminalSessionFrozenBlock(
        {
          terminalId: input.terminalId,
          sessionId: input.sessionId,
          kind,
          messageKey: item.messageKey,
          stepId: null,
          transcript: existingTranscript,
          sequence,
        },
        input.codexHome,
      );
      continue;
    }

    if (existingTranscript) {
      continue;
    }

    const transcript = deriveTranscriptTail({
      output,
      orderedKnownTranscripts,
    });
    if (!shouldFreezeTerminalTranscript(transcript)) {
      continue;
    }

    await persistTerminalSessionFrozenBlock(
      {
        terminalId: input.terminalId,
        sessionId: input.sessionId,
        kind,
        messageKey: item.messageKey,
        stepId: null,
        transcript,
        sequence,
      },
      input.codexHome,
    );
    orderedKnownTranscripts.push(transcript);
  }

  const finalArtifacts = await getPersistedTerminalSessionArtifacts(
    input.terminalId,
    { sessionId: input.sessionId },
    input.codexHome,
  );
  return {
    ...finalArtifacts,
    timelineEntries: buildTerminalTimelineEntries({
      messageKeys: embeddedMessages.map((item) => item.messageKey),
      blocks: finalArtifacts.blocks,
    }),
  };
}

export async function syncTrackedTerminalSessionArtifacts(input: {
  terminalId: string;
  sessionId: string;
  output: string;
  codexHome?: string | null;
  viewport?: {
    cols: number;
    rows: number;
  } | null;
}): Promise<{
  artifacts: TerminalSessionArtifactsResponse;
  changed: boolean;
}> {
  const artifacts = await syncTerminalSessionArtifacts(input);
  const key = JSON.stringify(artifacts);
  const previous = lastArtifactsPayloadByTerminalId.get(input.terminalId);
  lastArtifactsPayloadByTerminalId.set(input.terminalId, key);
  return {
    artifacts,
    changed: previous !== key,
  };
}

export function clearTerminalSessionSyncState(terminalId: string): void {
  lastArtifactsPayloadByTerminalId.delete(terminalId.trim());
}
