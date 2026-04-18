import type {
  ConversationMessage,
  TerminalSessionArtifactsResponse,
  TerminalSessionPlanStepFeedback,
} from "./storage";
import { getConversation } from "./storage";
import {
  getPersistedTerminalSessionArtifacts,
  persistTerminalSessionFrozenBlock,
  persistTerminalSessionMessageBlock,
} from "./terminal-session-store";
import {
  parseAiTerminalUserFeedback,
  extractConversationMessageText,
  getAiTerminalMessageKey,
  parseAiTerminalMessage,
} from "../web/ai-terminal";
import {
  buildTerminalTimelineEntries,
} from "./terminal-transcript";

const lastArtifactsPayloadByTerminalId = new Map<string, string>();

interface EmbeddedTerminalMessage {
  messageKey: string;
  message: ConversationMessage;
  rendered: NonNullable<ReturnType<typeof parseAiTerminalMessage>>;
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
    .map((message, index) => {
      const rendered = parseAiTerminalMessage(extractConversationMessageText(message));
      if (!rendered) {
        return null;
      }
      return {
        messageKey: getAiTerminalMessageKey(message) ?? `terminal-ai:${sessionId}:${index}`,
        message,
        rendered,
      };
    })
    .filter((item): item is EmbeddedTerminalMessage => item !== null);
}

function buildPlanFeedbackByMessageKey(
  sessionId: string,
  messages: ConversationMessage[],
): Record<string, TerminalSessionPlanStepFeedback[]> {
  const plans: Array<{ messageKey: string; stepIds: Set<string> }> = [];
  const feedbackByMessageKey = new Map<string, TerminalSessionPlanStepFeedback[]>();

  messages.forEach((message, index) => {
    const text = extractConversationMessageText(message);
    if (!text) {
      return;
    }

    const parsedDirective = parseAiTerminalMessage(text);
    if (message.type === "assistant" && parsedDirective?.directive.kind === "plan") {
      plans.push({
        messageKey:
          getAiTerminalMessageKey(message) ?? `terminal-ai:${sessionId}:${index}`,
        stepIds: new Set(parsedDirective.directive.steps.map((step) => step.stepId)),
      });
      return;
    }

    const parsedFeedback = parseAiTerminalUserFeedback(text);
    if (!parsedFeedback) {
      return;
    }

    for (let planIndex = plans.length - 1; planIndex >= 0; planIndex -= 1) {
      const plan = plans[planIndex];
      if (!plan?.stepIds.has(parsedFeedback.stepId)) {
        continue;
      }

      const items = feedbackByMessageKey.get(plan.messageKey) ?? [];
      const updatedAt = message.timestamp ?? new Date().toISOString();
      if (parsedFeedback.kind === "execution") {
        items.push({
          kind: "execution",
          stepId: parsedFeedback.stepId,
          updatedAt,
          status: parsedFeedback.status,
          exitCode: parsedFeedback.exitCode,
          cwdAfter: parsedFeedback.cwdAfter,
          outputSummary: parsedFeedback.outputSummary,
          errorSummary: parsedFeedback.errorSummary,
          outputReference: parsedFeedback.outputReference,
        });
      } else {
        items.push({
          kind: "rejection",
          stepId: parsedFeedback.stepId,
          updatedAt,
          decision: "rejected",
          reason: parsedFeedback.reason,
        });
      }
      feedbackByMessageKey.set(plan.messageKey, items);
      break;
    }
  });

  return Object.fromEntries(feedbackByMessageKey.entries());
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
  consumePendingSnapshot: () =>
    | Promise<TerminalSessionArtifactsResponse["blocks"][number]["snapshot"]>
    | TerminalSessionArtifactsResponse["blocks"][number]["snapshot"];
  codexHome?: string | null;
}): Promise<TerminalSessionArtifactsResponse> {
  const messages = await getConversation(input.sessionId);
  const embeddedMessages = listEmbeddedTerminalMessages(input.sessionId, messages);
  const planFeedbackByMessageKey = buildPlanFeedbackByMessageKey(
    input.sessionId,
    messages,
  );
  const persistedArtifacts = await getPersistedTerminalSessionArtifacts(
    input.terminalId,
    { sessionId: input.sessionId },
    input.codexHome,
  );

  const persistedByLogicalKey = new Map<string, TerminalSessionArtifactsResponse["blocks"][number]>(
    persistedArtifacts.blocks
      .filter((block) => block.type === "terminal_snapshot")
      .map((block) => [
        `${block.type}:${block.sessionId}:${block.messageKey ?? ""}:${block.stepId ?? ""}`,
        block,
      ] as const),
  );

  for (const [index, item] of embeddedMessages.entries()) {
    const snapshotSequence = index * 2 + 1;
    const messageSequence = index * 2 + 2;
    const directive = item.rendered.directive;

    if (directive.kind === "plan") {
      await persistTerminalSessionMessageBlock(
        {
          terminalId: input.terminalId,
          sessionId: input.sessionId,
          type: "ai_terminal_plan",
          messageKey: item.messageKey,
          sequence: messageSequence,
          leadingMarkdown: item.rendered.leadingMarkdown,
          trailingMarkdown: item.rendered.trailingMarkdown,
          rawBlock: item.rendered.rawBlock,
          contextNote: directive.contextNote,
          steps: directive.steps,
          stepFeedback: planFeedbackByMessageKey[item.messageKey] ?? null,
        },
        input.codexHome,
      );
    } else if (directive.kind === "need_input") {
      await persistTerminalSessionMessageBlock(
        {
          terminalId: input.terminalId,
          sessionId: input.sessionId,
          type: "ai_terminal_need_input",
          messageKey: item.messageKey,
          sequence: messageSequence,
          leadingMarkdown: item.rendered.leadingMarkdown,
          trailingMarkdown: item.rendered.trailingMarkdown,
          rawBlock: item.rendered.rawBlock,
          contextNote: directive.contextNote,
          question: directive.question,
        },
        input.codexHome,
      );
    } else {
      await persistTerminalSessionMessageBlock(
        {
          terminalId: input.terminalId,
          sessionId: input.sessionId,
          type: "ai_terminal_complete",
          messageKey: item.messageKey,
          sequence: messageSequence,
          leadingMarkdown: item.rendered.leadingMarkdown,
          trailingMarkdown: item.rendered.trailingMarkdown,
          rawBlock: item.rendered.rawBlock,
          message: directive.message,
        },
        input.codexHome,
      );
    }

    const captureKind = directive.kind === "finished" ? "auto" : "manual";
    const logicalKey = `terminal_snapshot:${input.sessionId}:${item.messageKey}:`;
    const existing = persistedByLogicalKey.get(logicalKey);
    const existingSnapshot = existing?.snapshot ?? null;

    const needsSequenceUpdate =
      existing &&
      (existing.sequence !== snapshotSequence ||
        existing.captureKind !== captureKind);
    if (existingSnapshot && needsSequenceUpdate) {
      await persistTerminalSessionFrozenBlock(
        {
          terminalId: input.terminalId,
          sessionId: input.sessionId,
          captureKind,
          messageKey: item.messageKey,
          stepId: null,
          snapshot: existingSnapshot,
          sequence: snapshotSequence,
        },
        input.codexHome,
      );
      continue;
    }

    if (existingSnapshot) {
      continue;
    }

    const snapshot = await input.consumePendingSnapshot();
    if (!snapshot) {
      continue;
    }

    await persistTerminalSessionFrozenBlock(
      {
        terminalId: input.terminalId,
        sessionId: input.sessionId,
        captureKind,
        messageKey: item.messageKey,
        stepId: null,
        snapshot,
        sequence: snapshotSequence,
      },
      input.codexHome,
    );
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
  consumePendingSnapshot: () =>
    | Promise<TerminalSessionArtifactsResponse["blocks"][number]["snapshot"]>
    | TerminalSessionArtifactsResponse["blocks"][number]["snapshot"];
  codexHome?: string | null;
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
