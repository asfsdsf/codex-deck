import type {
  ConversationMessage,
  WorkflowDetailResponse,
  WorkflowSummary,
} from "@codex-deck/api";
import { getViewportMessageGroup } from "./message-viewport-groups";

const STRICT_TASK_CREATE_QUESTION_SUFFIX =
  "<codex-deck-flow>Question<codex-deck-flow/>";
const STRICT_TASK_CREATE_REQUEST_APPROVE_REGEX =
  /<codex-deck-flow>Request approve:?(.+?)<codex-deck-flow\/>\s*$/s;

export type WorkflowChatSessionPlan =
  | {
      kind: "open-bound-session";
      sessionId: string;
      projectRoot: string;
      preserveProjectFilter: true;
    }
  | {
      kind: "create-bound-session";
      workflowId: string;
      projectRoot: string;
      preserveProjectFilter: true;
    }
  | {
      kind: "error";
      message: string;
    };

export type StrictTaskCreateAssistantDirective =
  | {
      kind: "none";
    }
  | {
      kind: "question";
    }
  | {
      kind: "request-approve";
      workflowFileName: string;
    };

export interface StrictTaskCreateImportedDraft {
  workflowKey: string;
  workflowPath: string;
  workflowId: string;
  workflowFileName: string;
  projectRoot: string;
  boundSessionId?: string | null;
}

function normalizePathForComparison(inputPath: string): string {
  const normalized = inputPath.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function getWorkflowFileName(workflowPath: string): string {
  return workflowPath.replace(/\\/g, "/").split("/").pop() ?? workflowPath;
}

function extractConversationMessageText(message: ConversationMessage): string {
  if (message.type === "summary") {
    return typeof message.summary === "string" ? message.summary.trim() : "";
  }

  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      const blockType = typeof block?.type === "string" ? block.type : "";
      if (
        blockType !== "text" &&
        blockType !== "output_text" &&
        blockType !== "input_text"
      ) {
        return [];
      }
      if (typeof block.text !== "string") {
        return [];
      }
      const text = block.text.trim();
      return text ? [text] : [];
    })
    .join("\n")
    .trim();
}

function isWorkflowCreatePreviewCandidate(
  message: ConversationMessage,
): boolean {
  return (
    message.type !== "user" && getViewportMessageGroup(message) === "important"
  );
}

export function getLatestWorkflowCreatePreviewMessage(
  messages: ConversationMessage[],
): ConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isWorkflowCreatePreviewCandidate(message)) {
      return message;
    }
  }

  return null;
}

export function getStrictTaskCreateDirectiveFromMessages(
  messages: ConversationMessage[],
  turnId?: string | null,
): StrictTaskCreateAssistantDirective {
  const normalizedTurnId = turnId?.trim() || "";
  const isStrictReplyMessage = (message: ConversationMessage) =>
    message?.type === "assistant" || message?.type === "summary";

  const candidateMessages = messages.filter((message) =>
    isStrictReplyMessage(message),
  );
  const turnMatchedMessages = normalizedTurnId
    ? candidateMessages.filter(
        (message) => (message.turnId ?? "") === normalizedTurnId,
      )
    : [];
  const relevantMessages =
    turnMatchedMessages.length > 0 ? turnMatchedMessages : candidateMessages;

  const latestAssistantText = relevantMessages
    .map((message) => extractConversationMessageText(message))
    .filter((text) => text.length > 0)
    .pop();
  return parseStrictTaskCreateAssistantDirective(latestAssistantText ?? "");
}

export function parseStrictTaskCreateAssistantDirective(
  text: string,
): StrictTaskCreateAssistantDirective {
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind: "none" };
  }
  if (trimmed.endsWith(STRICT_TASK_CREATE_QUESTION_SUFFIX)) {
    return { kind: "question" };
  }
  const match = trimmed.match(STRICT_TASK_CREATE_REQUEST_APPROVE_REGEX);
  if (!match) {
    return { kind: "none" };
  }
  const workflowFileName = (match[1] ?? "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  if (
    !workflowFileName ||
    workflowFileName === ":" ||
    !workflowFileName.toLowerCase().endsWith(".json")
  ) {
    return { kind: "none" };
  }
  return {
    kind: "request-approve",
    workflowFileName,
  };
}

export function resolveStrictTaskCreateDraft(
  workflows: WorkflowSummary[],
  projectRoot: string,
  workflowFileName: string,
): StrictTaskCreateImportedDraft | null {
  const normalizedProjectRoot = normalizePathForComparison(projectRoot);
  const normalizedFileName = workflowFileName
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  if (!normalizedProjectRoot || !normalizedFileName) {
    return null;
  }
  const expectedWorkflowPath = normalizePathForComparison(
    `${normalizedProjectRoot}/.codex-deck/${normalizedFileName}`,
  );
  const match = workflows.find(
    (workflow) =>
      normalizePathForComparison(workflow.workflowPath) ===
      expectedWorkflowPath,
  );
  if (!match) {
    return null;
  }
  return {
    workflowKey: match.key,
    workflowPath: match.workflowPath,
    workflowId: match.id,
    workflowFileName: getWorkflowFileName(match.workflowPath),
    projectRoot: match.projectRoot,
  };
}

export function buildStrictTaskCreateApprovalMessage(
  draft: StrictTaskCreateImportedDraft,
  boundSessionId: string,
): string {
  return `Approve. The workflow draft already exists. Do not create it again. Reuse the existing workflow and continue from it.\n\nWorkflow data:\n${JSON.stringify(
    {
      workflowPath: draft.workflowPath,
      workflowFileName: draft.workflowFileName,
      workflowId: draft.workflowId,
      projectRoot: draft.projectRoot,
      boundSessionId,
    },
  )}`;
}

export function resolveWorkflowChatSessionPlan(
  workflow: WorkflowDetailResponse,
): WorkflowChatSessionPlan {
  const projectRoot = workflow.summary.projectRoot.trim();
  const boundSessionId = workflow.boundSessionId?.trim() ?? "";
  if (boundSessionId) {
    return {
      kind: "open-bound-session",
      sessionId: boundSessionId,
      projectRoot,
      preserveProjectFilter: true,
    };
  }

  const workflowId = workflow.summary.id.trim();
  if (!workflowId) {
    return {
      kind: "error",
      message: "This workflow does not have a workflow ID.",
    };
  }

  if (!projectRoot) {
    return {
      kind: "error",
      message: "This workflow does not have a project path.",
    };
  }

  return {
    kind: "create-bound-session",
    workflowId,
    projectRoot,
    preserveProjectFilter: true,
  };
}
