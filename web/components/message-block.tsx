import { useEffect, useState, memo } from "react";
import type {
  ConversationMessage,
  ContentBlock,
  CodexApprovalRequest,
  CodexApprovalResponsePayload,
  CodexUserInputRequest,
} from "@codex-deck/api";
import {
  Lightbulb,
  AlertTriangle,
  Wrench,
  Check,
  X,
  Terminal,
  Search,
  Pencil,
  FolderOpen,
  Globe,
  MessageSquare,
  ListTodo,
  FilePlus2,
  FileCode,
  GitBranch,
  Database,
  HardDrive,
  Bot,
  ImageIcon,
  Clock3,
} from "lucide-react";
import { shouldDefaultExpandToolUse } from "../message-block-utils";
import { getTokenLimitNoticeRepeatCount } from "../token-limit-notices";
import { formatDurationFromTimestamps, sanitizeText } from "../utils";
import { getPathTail } from "../path-utils";
import {
  parseAiTerminalBootstrapMessage,
  parseAiTerminalCommandOutputMessage,
  parseAiTerminalMessage,
  parseAiTerminalUserFeedback,
  type AiTerminalBootstrapMessage,
  type AiTerminalCommandOutputMessage,
  type AiTerminalDirective,
  type AiTerminalExecutionFeedback,
  type AiTerminalExecutionStatus,
  type AiTerminalPlanDirective,
  type AiTerminalRejectionFeedback,
  type AiTerminalStepDirective,
  type AiTerminalStepState,
  type AiTerminalUserFeedback,
} from "../ai-terminal";
import { getFencedCodeBlock, MarkdownRenderer } from "./markdown-renderer";
import { PatchTextRenderer, getPatchFileTypes } from "./patch-text-renderer";
import {
  AskQuestionRenderer,
  BashRenderer,
  CopyButton,
  EditRenderer,
  FunctionToolResultRenderer,
  GlobRenderer,
  GrepRenderer,
  ReadRenderer,
  TaskRenderer,
  TodoRenderer,
  WriteRenderer,
} from "./tool-renderers";

interface MessageBlockProps {
  message: ConversationMessage;
  userTone?: "default" | "pending";
  isAgentsBootstrap?: boolean;
  searchForcePrimaryExpanded?: boolean;
  searchForceBlockIndex?: number | null;
  fallbackToolMap?: Map<string, string>;
  fallbackToolInputMap?: Map<string, Record<string, unknown>>;
  fallbackToolTimestampMap?: Map<string, string>;
  onPlanAction?: (action: "implement" | "stay") => void;
  onFilePathLinkClick?: (href: string) => boolean;
  pendingUserInputRequests?: CodexUserInputRequest[];
  pendingApprovalRequests?: CodexApprovalRequest[];
  selectedUserInputAnswers?: Record<
    string,
    Record<
      string,
      {
        optionLabel: string;
        otherText: string;
      }
    >
  >;
  submittingUserInputRequestIds?: string[];
  submittingApprovalRequestIds?: string[];
  onSelectUserInputOption?: (
    request: CodexUserInputRequest,
    questionId: string,
    optionLabel: string,
  ) => void;
  onChangeUserInputOtherText?: (
    request: CodexUserInputRequest,
    questionId: string,
    text: string,
  ) => void;
  onSubmitUserInputAnswers?: (request: CodexUserInputRequest) => void;
  onRespondApprovalRequest?: (
    request: CodexApprovalRequest,
    response: CodexApprovalResponsePayload,
  ) => void;
  aiTerminalContext?: {
    sessionId: string;
    terminalId: string;
    messageKey: string;
    isActionable: boolean;
    stepStates?: Record<string, AiTerminalStepState | undefined>;
    onApproveStep?: (input: {
      sessionId: string;
      terminalId: string;
      messageKey: string;
      step: AiTerminalStepDirective;
    }) => void;
    onRejectStep?: (input: {
      sessionId: string;
      terminalId: string;
      messageKey: string;
      step: AiTerminalStepDirective;
      reason: string;
    }) => void;
  };
  resolvedUserInputAnswersByItemId?: Map<
    string,
    Record<
      string,
      {
        optionLabel: string;
        otherText: string;
      }
    >
  >;
  suppressedRequestUserInputResultIds?: Set<string>;
}

function buildToolMap(content: ContentBlock[]): Map<string, string> {
  const toolMap = new Map<string, string>();
  for (const block of content) {
    if (block.type === "tool_use" && block.id && block.name) {
      toolMap.set(block.id, block.name);
    }
  }
  return toolMap;
}

function buildToolInputMap(
  content: ContentBlock[],
): Map<string, Record<string, unknown>> {
  const toolInputMap = new Map<string, Record<string, unknown>>();
  for (const block of content) {
    if (
      block.type === "tool_use" &&
      block.id &&
      block.input &&
      typeof block.input === "object" &&
      !Array.isArray(block.input)
    ) {
      toolInputMap.set(block.id, block.input as Record<string, unknown>);
    }
  }
  return toolInputMap;
}

function buildToolTimestampMap(content: ContentBlock[]): Map<string, string> {
  const toolTimestampMap = new Map<string, string>();
  for (const block of content) {
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.timestamp === "string" &&
      block.timestamp.trim().length > 0
    ) {
      toolTimestampMap.set(block.id, block.timestamp);
    }
  }
  return toolTimestampMap;
}

function formatReasoningText(text: string): string {
  const sanitized = sanitizeText(text).trim();
  return sanitized.replace(/^\*\*(.*?)\*\*$/s, "$1").trim();
}

function getReasoningPreview(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length > maxLength) {
    return `${normalized.slice(0, maxLength)}...`;
  }
  return withMultilineCollapsedIndicator(normalized, text);
}

function stringifyJson(value: unknown): string {
  try {
    return sanitizeText(JSON.stringify(value, null, 2) ?? "null");
  } catch {
    return sanitizeText(String(value));
  }
}

function JsonRenderer(props: {
  value: unknown;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const content = stringifyJson(props.value);

  if (!content) {
    return null;
  }

  return (
    <MarkdownRenderer
      content={getFencedCodeBlock(content, "json")}
      onFilePathLinkClick={props.onFilePathLinkClick}
    />
  );
}

type JsonViewMode = "formatted" | "raw";

type ProposedPlanParseResult = {
  planMarkdown: string;
  trailingMarkdown: string;
};

const PROPOSED_PLAN_BLOCK_REGEX =
  /^<proposed_plan>\n([\s\S]*?)\n<\/proposed_plan>([\s\S]*)$/;
const TURN_ABORTED_BLOCK_REGEX =
  /^\s*<turn_aborted>\s*([\s\S]*?)\s*<\/turn_aborted>\s*$/i;
const SKILL_BLOCK_REGEX = /^\s*<skill>\s*([\s\S]*?)\s*<\/skill>\s*$/i;

type SkillBlockContent = {
  name: string | null;
  path: string | null;
  rawContent: string;
  markdownContent: string;
};

function parseProposedPlanBlock(text: string): ProposedPlanParseResult | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(PROPOSED_PLAN_BLOCK_REGEX);
  if (!match) {
    return null;
  }

  const planMarkdown = match[1].trim();
  if (!planMarkdown) {
    return null;
  }

  return {
    planMarkdown,
    trailingMarkdown: match[2].trim(),
  };
}

function getTurnAbortedDisplayText(
  content: string | ContentBlock[] | undefined,
): string | null {
  if (typeof content === "string") {
    const sanitized = sanitizeText(content).trim();
    if (!sanitized) {
      return null;
    }

    const match = sanitized.match(TURN_ABORTED_BLOCK_REGEX);
    if (!match) {
      return sanitized;
    }

    const extracted = match[1].trim();
    return extracted || null;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        const text = sanitizeText(block.text).trim();
        if (text) {
          return text;
        }
      }
    }
  }

  return null;
}

function getMessageCopyText(
  content: string | ContentBlock[] | undefined,
): string | null {
  if (typeof content === "string") {
    const sanitized = sanitizeText(content);
    return sanitized.length > 0 ? sanitized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => sanitizeText(block.text ?? ""))
    .filter((value) => value.length > 0)
    .join("\n\n");

  return text.length > 0 ? text : null;
}

function getMessageRawText(
  content: string | ContentBlock[] | undefined,
): string | null {
  if (typeof content === "string") {
    const normalized = content.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter((value) => value.length > 0)
    .join("\n\n");

  return text.length > 0 ? text : null;
}

function getCollapsedPreviewLines(text: string, maxLines: number): string {
  if (!text) {
    return "";
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }

  const preview = lines.slice(0, maxLines).join("\n");
  return lines.length > maxLines ? `${preview}...` : preview;
}

function extractAgentsInstructionsContent(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(
    /<INSTRUCTIONS>\s*([\s\S]*?)\s*<\/INSTRUCTIONS>/i,
  );
  if (!match) {
    return text.trim();
  }
  return match[1].trim();
}

function extractSkillBlockContent(text: string): SkillBlockContent | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(SKILL_BLOCK_REGEX);
  if (!match) {
    return null;
  }

  const rawContent = match[1].trim();
  if (!rawContent) {
    return null;
  }

  const nameMatch = rawContent.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
  const pathMatch = rawContent.match(/<path>\s*([\s\S]*?)\s*<\/path>/i);
  const name = nameMatch?.[1]?.trim() || null;
  const path = pathMatch?.[1]?.trim() || null;

  const markdownContent = rawContent
    .replace(/<name>\s*[\s\S]*?\s*<\/name>\s*/i, "")
    .replace(/<path>\s*[\s\S]*?\s*<\/path>\s*/i, "")
    .trim();

  return {
    name,
    path,
    rawContent,
    markdownContent: markdownContent || rawContent,
  };
}

function ProposedPlanRenderer(props: {
  planMarkdown: string;
  trailingMarkdown: string;
  onPlanAction?: (action: "implement" | "stay") => void;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const { planMarkdown, trailingMarkdown, onPlanAction, onFilePathLinkClick } =
    props;
  const [chosenAction, setChosenAction] = useState<"implement" | "stay" | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<
    "implement" | "stay" | null
  >(null);

  const handlePlanActionClick = (action: "implement" | "stay") => {
    if (!onPlanAction || pendingAction || chosenAction) {
      return;
    }

    setChosenAction(action);
    setPendingAction(action);

    try {
      const result = onPlanAction(action);
      void Promise.resolve(result)
        .catch(() => {
          setChosenAction((current) => (current === action ? null : current));
        })
        .finally(() => {
          setPendingAction((current) => (current === action ? null : current));
        });
    } catch {
      setChosenAction(null);
      setPendingAction(null);
    }
  };

  return (
    <div className="my-1 rounded-xl border border-sky-400/35 bg-sky-500/10 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-sky-200/90">
        Plan Proposal
      </div>
      <MarkdownRenderer
        content={planMarkdown}
        onFilePathLinkClick={onFilePathLinkClick}
      />
      {onPlanAction && !chosenAction && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handlePlanActionClick("implement")}
            disabled={pendingAction !== null}
            className="rounded-lg border border-emerald-400/30 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pendingAction === "implement"
              ? "Implementing..."
              : "Yes, implement this plan"}
          </button>
          <button
            type="button"
            onClick={() => handlePlanActionClick("stay")}
            disabled={pendingAction !== null}
            className="rounded-lg border border-zinc-500/35 bg-zinc-500/10 px-2.5 py-1.5 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pendingAction === "stay"
              ? "Staying in Plan mode..."
              : "No, stay in Plan mode"}
          </button>
        </div>
      )}
      {chosenAction === "stay" && (
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-zinc-500/35 bg-zinc-500/10 px-2.5 py-1.5 text-[11px] text-zinc-200">
          <Check size={12} className="opacity-70" />
          <span>Staying in Plan mode</span>
        </div>
      )}
      {chosenAction === "implement" && (
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/35 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] text-emerald-100">
          <Check size={12} className="opacity-70" />
          <span>Implementing this plan</span>
        </div>
      )}
      {trailingMarkdown && (
        <div className="mt-2 border-t border-sky-500/20 pt-2">
          <MarkdownRenderer
            content={trailingMarkdown}
            onFilePathLinkClick={onFilePathLinkClick}
          />
        </div>
      )}
    </div>
  );
}

function getAiTerminalStepStateLabel(
  state: AiTerminalStepState | undefined,
  isActionable: boolean,
): string | null {
  if (state === "running") {
    return "Running";
  }
  if (state === "completed") {
    return "Completed";
  }
  if (state === "failed") {
    return "Failed";
  }
  if (state === "rejected") {
    return "Rejected";
  }
  if (isActionable) {
    return "Pending";
  }
  return null;
}

function getAiTerminalStepStateClasses(
  state: AiTerminalStepState | undefined,
  isActionable: boolean,
): string {
  if (state === "running") {
    return "border-cyan-400/35 bg-cyan-500/15 text-cyan-100";
  }
  if (state === "completed") {
    return "border-emerald-400/35 bg-emerald-500/15 text-emerald-100";
  }
  if (state === "failed") {
    return "border-rose-400/35 bg-rose-500/15 text-rose-100";
  }
  if (state === "rejected") {
    return "border-zinc-400/35 bg-zinc-500/15 text-zinc-100";
  }
  if (isActionable) {
    return "border-amber-400/35 bg-amber-500/15 text-amber-100";
  }
  return "border-zinc-600/35 bg-zinc-800/55 text-zinc-300";
}

function AiTerminalRejectControl(props: {
  sessionId: string;
  terminalId: string;
  messageKey: string;
  step: AiTerminalStepDirective;
  onRejectStep: NonNullable<
    NonNullable<MessageBlockProps["aiTerminalContext"]>["onRejectStep"]
  >;
}) {
  const [reason, setReason] = useState("");
  const normalizedReason = reason.trim();

  return (
    <div className="relative min-h-12 w-full min-w-0 flex-1 rounded-lg border border-zinc-500/35 bg-zinc-950/70 focus-within:border-zinc-400/60 focus-within:ring-1 focus-within:ring-zinc-400/20 sm:min-w-[16rem]">
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={2}
        aria-label="Reject reason"
        placeholder="Tell the bound session why this step should change..."
        className="block min-h-12 w-full resize-none bg-transparent py-2 pl-24 pr-2.5 text-[11px] leading-4 text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
      />
      <button
        type="button"
        onClick={() =>
          props.onRejectStep({
            sessionId: props.sessionId,
            terminalId: props.terminalId,
            messageKey: props.messageKey,
            step: props.step,
            reason: normalizedReason,
          })
        }
        disabled={!normalizedReason}
        className="absolute left-1.5 top-1.5 rounded-lg border border-rose-500/45 bg-rose-500/15 px-3 py-1.5 text-[11px] text-rose-100 transition-colors hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-45"
      >
        Reject
      </button>
    </div>
  );
}

function AiTerminalPlanRenderer(props: {
  plan: AiTerminalPlanDirective;
  trailingMarkdown: string;
  leadingMarkdown: string;
  aiTerminalContext?: MessageBlockProps["aiTerminalContext"];
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const { plan, trailingMarkdown, leadingMarkdown, aiTerminalContext } = props;

  return (
    <div className="my-1 space-y-3">
      {leadingMarkdown ? (
        <MarkdownRenderer
          content={leadingMarkdown}
          onFilePathLinkClick={props.onFilePathLinkClick}
        />
      ) : null}
      <div className="rounded-xl border border-cyan-400/35 bg-zinc-950/70 p-3 shadow-[0_0_0_1px_rgba(8,145,178,0.08)]">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/90">
            AI Terminal Plan
          </div>
          <div className="text-[10px] text-zinc-500">
            {plan.steps.length} step{plan.steps.length === 1 ? "" : "s"}
          </div>
        </div>
        {plan.contextNote ? (
          <div className="mt-2 text-xs leading-relaxed text-zinc-300">
            <MarkdownRenderer
              content={plan.contextNote}
              onFilePathLinkClick={props.onFilePathLinkClick}
            />
          </div>
        ) : null}
        <div className="mt-3 space-y-3">
          {plan.steps.map((step, index) => {
            const state = aiTerminalContext?.stepStates?.[step.stepId];
            const stateLabel = getAiTerminalStepStateLabel(
              state,
              aiTerminalContext?.isActionable === true,
            );
            const hasChosenAction =
              state === "running" ||
              state === "completed" ||
              state === "failed" ||
              state === "rejected";
            const canApprove =
              aiTerminalContext?.isActionable === true &&
              step.nextAction !== "provide_input" &&
              !hasChosenAction;
            const canReject =
              aiTerminalContext?.isActionable === true && !hasChosenAction;

            return (
              <div
                key={step.stepId}
                className="rounded-xl border border-zinc-800/80 bg-zinc-900/80 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950 px-1.5 text-[10px] font-medium text-zinc-200">
                    {index + 1}
                  </div>
                  <div className="text-sm font-medium text-zinc-100">
                    {step.stepGoal ?? `Step ${index + 1}`}
                  </div>
                  <div className="inline-flex items-center rounded-full border border-zinc-700/70 bg-zinc-950/80 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                    Risk {step.risk}
                  </div>
                  {stateLabel ? (
                    <div
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${getAiTerminalStepStateClasses(
                        state,
                        aiTerminalContext?.isActionable === true,
                      )}`}
                    >
                      {stateLabel}
                    </div>
                  ) : null}
                </div>

                <div className="mt-2 rounded-lg border border-zinc-800 bg-black/30 p-3">
                  <div className="command-syntax command-syntax-block whitespace-pre-wrap break-all text-sm text-zinc-100">
                    {step.command}
                  </div>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                  {step.cwd ? (
                    <span className="rounded border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono">
                      {step.cwd}
                    </span>
                  ) : null}
                  {step.shell ? (
                    <span className="rounded border border-zinc-800 bg-zinc-950/70 px-2 py-1 font-mono">
                      {step.shell}
                    </span>
                  ) : null}
                  <CopyButton
                    text={step.command}
                    title="Copy command"
                    className="rounded border border-zinc-700/70 bg-zinc-900/70 hover:bg-zinc-800/70"
                  />
                </div>

                {step.explanation ? (
                  <div className="mt-2 text-xs leading-relaxed text-zinc-300">
                    <MarkdownRenderer
                      content={step.explanation}
                      onFilePathLinkClick={props.onFilePathLinkClick}
                    />
                  </div>
                ) : null}

                {step.contextNote ? (
                  <div className="mt-2 text-xs leading-relaxed text-zinc-400">
                    <MarkdownRenderer
                      content={step.contextNote}
                      onFilePathLinkClick={props.onFilePathLinkClick}
                    />
                  </div>
                ) : null}

                {step.nextAction === "provide_input" ? (
                  <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-100">
                    This step needs more user input. Reply in the chat composer
                    to continue.
                  </div>
                ) : null}

                {(canApprove || canReject) && (
                  <div className="mt-3 flex flex-wrap items-start gap-2">
                    {canApprove ? (
                      <button
                        type="button"
                        onClick={() =>
                          aiTerminalContext?.onApproveStep?.({
                            sessionId: aiTerminalContext.sessionId,
                            terminalId: aiTerminalContext.terminalId,
                            messageKey: aiTerminalContext.messageKey,
                            step,
                          })
                        }
                        className="rounded-lg border border-cyan-500/45 bg-cyan-500/15 px-3 py-1.5 text-[11px] text-cyan-100 transition-colors hover:bg-cyan-500/25"
                      >
                        Approve and run
                      </button>
                    ) : null}
                    {canReject && aiTerminalContext?.onRejectStep ? (
                      <AiTerminalRejectControl
                        sessionId={aiTerminalContext.sessionId}
                        terminalId={aiTerminalContext.terminalId}
                        messageKey={aiTerminalContext.messageKey}
                        step={step}
                        onRejectStep={aiTerminalContext.onRejectStep}
                      />
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {trailingMarkdown ? (
        <MarkdownRenderer
          content={trailingMarkdown}
          onFilePathLinkClick={props.onFilePathLinkClick}
        />
      ) : null}
    </div>
  );
}

function AiTerminalDirectiveRenderer(props: {
  directive: AiTerminalDirective;
  leadingMarkdown: string;
  trailingMarkdown: string;
  aiTerminalContext?: MessageBlockProps["aiTerminalContext"];
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  if (props.directive.kind === "plan") {
    return (
      <AiTerminalPlanRenderer
        plan={props.directive}
        leadingMarkdown={props.leadingMarkdown}
        trailingMarkdown={props.trailingMarkdown}
        aiTerminalContext={props.aiTerminalContext}
        onFilePathLinkClick={props.onFilePathLinkClick}
      />
    );
  }

  if (props.directive.kind === "need_input") {
    return (
      <div className="my-1 space-y-3">
        {props.leadingMarkdown ? (
          <MarkdownRenderer
            content={props.leadingMarkdown}
            onFilePathLinkClick={props.onFilePathLinkClick}
          />
        ) : null}
        <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-100/90">
            AI Terminal Needs Input
          </div>
          <div className="mt-2 text-sm text-zinc-100">
            {props.directive.question}
          </div>
          {props.directive.contextNote ? (
            <div className="mt-2 text-xs text-zinc-300">
              <MarkdownRenderer
                content={props.directive.contextNote}
                onFilePathLinkClick={props.onFilePathLinkClick}
              />
            </div>
          ) : null}
        </div>
        {props.trailingMarkdown ? (
          <MarkdownRenderer
            content={props.trailingMarkdown}
            onFilePathLinkClick={props.onFilePathLinkClick}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="my-1 space-y-3">
      {props.leadingMarkdown ? (
        <MarkdownRenderer
          content={props.leadingMarkdown}
          onFilePathLinkClick={props.onFilePathLinkClick}
        />
      ) : null}
      <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-100/90">
          AI Terminal Complete
        </div>
        <div className="mt-2 text-sm text-zinc-100">
          {props.directive.message}
        </div>
      </div>
      {props.trailingMarkdown ? (
        <MarkdownRenderer
          content={props.trailingMarkdown}
          onFilePathLinkClick={props.onFilePathLinkClick}
        />
      ) : null}
    </div>
  );
}

function getAiTerminalExecutionStatusLabel(
  status: AiTerminalExecutionStatus,
): string {
  if (status === "success") {
    return "Success";
  }
  if (status === "failed") {
    return "Failed";
  }
  if (status === "timed_out") {
    return "Timed out";
  }
  return "Completed";
}

function getAiTerminalFeedbackStatusClasses(
  feedback: AiTerminalUserFeedback,
): string {
  if (feedback.kind === "rejection") {
    return "border-zinc-500/40 bg-zinc-500/15 text-zinc-100";
  }
  if (
    feedback.status === "success" ||
    feedback.status === "completed_unknown"
  ) {
    return "border-emerald-400/40 bg-emerald-500/15 text-emerald-100";
  }
  if (feedback.status === "timed_out") {
    return "border-amber-400/40 bg-amber-500/15 text-amber-100";
  }
  return "border-rose-400/40 bg-rose-500/15 text-rose-100";
}

function AiTerminalFeedbackTextSection(props: {
  label: string;
  content: string;
  tone?: "default" | "error";
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  return (
    <div
      className={`border-t pt-2 ${
        props.tone === "error"
          ? "border-rose-400/20 text-rose-50/95"
          : "border-zinc-700/55 text-zinc-100"
      }`}
    >
      <div
        className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
          props.tone === "error" ? "text-rose-200/90" : "text-zinc-400"
        }`}
      >
        {props.label}
      </div>
      <div className="text-xs leading-relaxed">
        <MarkdownRenderer
          content={props.content}
          onFilePathLinkClick={props.onFilePathLinkClick}
        />
      </div>
    </div>
  );
}

function AiTerminalExecutionFeedbackBody(props: {
  feedback: AiTerminalExecutionFeedback;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const { feedback } = props;

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-300">
        {feedback.exitCode !== null ? (
          <span className="rounded border border-zinc-700/70 bg-zinc-950/60 px-2 py-1 font-mono">
            Exit {feedback.exitCode}
          </span>
        ) : null}
        {feedback.cwdAfter ? (
          <span
            className="max-w-full truncate rounded border border-zinc-700/70 bg-zinc-950/60 px-2 py-1 font-mono"
            title={feedback.cwdAfter}
          >
            {feedback.cwdAfter}
          </span>
        ) : null}
      </div>
      {feedback.outputSummary ? (
        <AiTerminalFeedbackTextSection
          label="Output"
          content={feedback.outputSummary}
          onFilePathLinkClick={props.onFilePathLinkClick}
        />
      ) : null}
      {feedback.errorSummary ? (
        <AiTerminalFeedbackTextSection
          label="Error"
          content={feedback.errorSummary}
          tone="error"
          onFilePathLinkClick={props.onFilePathLinkClick}
        />
      ) : null}
      {feedback.outputReference ? (
        <div className="border-t border-zinc-700/55 pt-2 text-[11px] text-zinc-400">
          <span className="mr-1.5 uppercase tracking-[0.14em] text-zinc-500">
            Reference
          </span>
          <span className="font-mono text-zinc-300">
            {feedback.outputReference}
          </span>
        </div>
      ) : null}
    </>
  );
}

function AiTerminalRejectionFeedbackBody(props: {
  feedback: AiTerminalRejectionFeedback;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  if (!props.feedback.reason) {
    return (
      <div className="border-t border-zinc-700/55 pt-2 text-xs text-zinc-400">
        No rejection reason was provided.
      </div>
    );
  }

  return (
    <AiTerminalFeedbackTextSection
      label="Reason"
      content={props.feedback.reason}
      onFilePathLinkClick={props.onFilePathLinkClick}
    />
  );
}

function AiTerminalBootstrapDetail(props: {
  label: string;
  value: string | null;
}) {
  if (!props.value) {
    return null;
  }

  return (
    <div className="flex min-w-0 items-start gap-2 text-xs">
      <span className="w-20 shrink-0 text-zinc-500">{props.label}</span>
      <span className="min-w-0 break-words font-mono text-zinc-200">
        {props.value}
      </span>
    </div>
  );
}

function AiTerminalBootstrapRenderer(props: {
  bootstrap: AiTerminalBootstrapMessage;
  copyText: string;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const [viewMode, setViewMode] = useState<JsonViewMode>("formatted");
  const { bootstrap } = props;

  return (
    <div className="flex justify-end min-w-0">
      <div className="max-w-[92%] min-w-0">
        <div className="overflow-hidden rounded-lg border border-zinc-700/65 bg-zinc-900/90 text-zinc-100 shadow-[0_0_0_1px_rgba(99,102,241,0.08)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-700/55 px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-200">
                <Terminal size={13} className="shrink-0 opacity-75" />
                <span>Terminal Chat</span>
              </div>
              <span className="inline-flex items-center rounded border border-cyan-400/40 bg-cyan-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-cyan-100">
                Bound
              </span>
              <span
                className="min-w-0 truncate rounded border border-zinc-700/70 bg-zinc-950/60 px-2 py-0.5 font-mono text-[10px] text-zinc-300"
                title={bootstrap.terminalId}
              >
                {bootstrap.terminalId}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <CopyButton
                text={props.copyText}
                title="Copy message"
                className="rounded-lg border border-zinc-600/55 bg-zinc-950/70 hover:bg-zinc-900/80"
              />
              <button
                type="button"
                onClick={() =>
                  setViewMode((current) =>
                    current === "formatted" ? "raw" : "formatted",
                  )
                }
                className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                  viewMode === "raw"
                    ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                    : "border-zinc-600/55 bg-zinc-950/70 text-zinc-300 hover:bg-zinc-900/80"
                }`}
                title={
                  viewMode === "raw" ? "Show formatted view" : "Show raw text"
                }
              >
                {"</>"}
              </button>
            </div>
          </div>
          <div className="space-y-2 px-3.5 py-2.5">
            {viewMode === "raw" ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-300">
                {props.copyText}
              </pre>
            ) : (
              <>
                <div className="space-y-1.5">
                  <AiTerminalBootstrapDetail
                    label="CWD"
                    value={bootstrap.cwd}
                  />
                  <AiTerminalBootstrapDetail
                    label="Shell"
                    value={bootstrap.shell}
                  />
                  <AiTerminalBootstrapDetail
                    label="OS"
                    value={
                      [bootstrap.osName, bootstrap.osRelease]
                        .filter(Boolean)
                        .join(" ") || null
                    }
                  />
                  <AiTerminalBootstrapDetail
                    label="Platform"
                    value={
                      [bootstrap.architecture, bootstrap.platform]
                        .filter(Boolean)
                        .join(" / ") || null
                    }
                  />
                </div>
                {bootstrap.userRequest ? (
                  <AiTerminalFeedbackTextSection
                    label="First request"
                    content={bootstrap.userRequest}
                    onFilePathLinkClick={props.onFilePathLinkClick}
                  />
                ) : null}
                {bootstrap.terminalCommandOutput ? (
                  <AiTerminalFeedbackTextSection
                    label="Frozen output"
                    content={bootstrap.terminalCommandOutput}
                    onFilePathLinkClick={props.onFilePathLinkClick}
                  />
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AiTerminalCommandOutputRenderer(props: {
  message: AiTerminalCommandOutputMessage;
  copyText: string;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const [viewMode, setViewMode] = useState<JsonViewMode>("formatted");
  const requestText = [
    props.message.leadingMarkdown,
    props.message.trailingMarkdown,
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");

  return (
    <div className="flex justify-end min-w-0">
      <div className="max-w-[92%] min-w-0">
        <div className="overflow-hidden rounded-lg border border-zinc-700/65 bg-zinc-900/90 text-zinc-100 shadow-[0_0_0_1px_rgba(99,102,241,0.08)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-700/55 px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-200">
                <Terminal size={13} className="shrink-0 opacity-75" />
                <span>Terminal Context</span>
              </div>
              <span
                className="min-w-0 truncate rounded border border-zinc-700/70 bg-zinc-950/60 px-2 py-0.5 font-mono text-[10px] text-zinc-300"
                title={props.message.terminalId}
              >
                {props.message.terminalId}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <CopyButton
                text={props.copyText}
                title="Copy message"
                className="rounded-lg border border-zinc-600/55 bg-zinc-950/70 hover:bg-zinc-900/80"
              />
              <button
                type="button"
                onClick={() =>
                  setViewMode((current) =>
                    current === "formatted" ? "raw" : "formatted",
                  )
                }
                className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                  viewMode === "raw"
                    ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                    : "border-zinc-600/55 bg-zinc-950/70 text-zinc-300 hover:bg-zinc-900/80"
                }`}
                title={
                  viewMode === "raw" ? "Show formatted view" : "Show raw text"
                }
              >
                {"</>"}
              </button>
            </div>
          </div>
          <div className="space-y-2 px-3.5 py-2.5">
            {viewMode === "raw" ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-300">
                {props.copyText}
              </pre>
            ) : (
              <>
                {requestText ? (
                  <AiTerminalFeedbackTextSection
                    label="Message"
                    content={requestText}
                    onFilePathLinkClick={props.onFilePathLinkClick}
                  />
                ) : null}
                <AiTerminalFeedbackTextSection
                  label="Frozen output"
                  content={props.message.commandOutput}
                  onFilePathLinkClick={props.onFilePathLinkClick}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AiTerminalUserFeedbackRenderer(props: {
  feedback: AiTerminalUserFeedback;
  copyText: string;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const { feedback } = props;
  const [viewMode, setViewMode] = useState<JsonViewMode>("formatted");
  const statusLabel =
    feedback.kind === "rejection"
      ? "Rejected"
      : getAiTerminalExecutionStatusLabel(feedback.status);
  const StatusIcon =
    feedback.kind === "rejection"
      ? X
      : feedback.status === "success" || feedback.status === "completed_unknown"
        ? Check
        : feedback.status === "timed_out"
          ? Clock3
          : AlertTriangle;

  return (
    <div className="flex justify-end min-w-0">
      <div className="max-w-[92%] min-w-0">
        <div className="overflow-hidden rounded-lg border border-zinc-700/65 bg-zinc-900/90 text-zinc-100 shadow-[0_0_0_1px_rgba(99,102,241,0.08)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-700/55 px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-200">
                <Terminal size={13} className="shrink-0 opacity-75" />
                <span>Terminal Step</span>
              </div>
              <span
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${getAiTerminalFeedbackStatusClasses(
                  feedback,
                )}`}
              >
                <StatusIcon size={11} className="opacity-80" />
                {statusLabel}
              </span>
              <span
                className="min-w-0 truncate rounded border border-zinc-700/70 bg-zinc-950/60 px-2 py-0.5 font-mono text-[10px] text-zinc-300"
                title={feedback.stepId}
              >
                {feedback.stepId}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <CopyButton
                text={props.copyText}
                title="Copy message"
                className="rounded-lg border border-zinc-600/55 bg-zinc-950/70 hover:bg-zinc-900/80"
              />
              <button
                type="button"
                onClick={() =>
                  setViewMode((current) =>
                    current === "formatted" ? "raw" : "formatted",
                  )
                }
                className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                  viewMode === "raw"
                    ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                    : "border-zinc-600/55 bg-zinc-950/70 text-zinc-300 hover:bg-zinc-900/80"
                }`}
                title={
                  viewMode === "raw" ? "Show formatted view" : "Show raw text"
                }
              >
                {"</>"}
              </button>
            </div>
          </div>
          <div className="space-y-2 px-3.5 py-2.5">
            {viewMode === "raw" ? (
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-300">
                {props.copyText}
              </pre>
            ) : (
              <>
                {feedback.kind === "execution" ? (
                  <AiTerminalExecutionFeedbackBody
                    feedback={feedback}
                    onFilePathLinkClick={props.onFilePathLinkClick}
                  />
                ) : (
                  <AiTerminalRejectionFeedbackBody
                    feedback={feedback}
                    onFilePathLinkClick={props.onFilePathLinkClick}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const MessageBlock = memo(function MessageBlock(props: MessageBlockProps) {
  const {
    message,
    userTone = "default",
    isAgentsBootstrap = false,
    searchForcePrimaryExpanded = false,
    searchForceBlockIndex = null,
    fallbackToolMap,
    fallbackToolInputMap,
    fallbackToolTimestampMap,
    onPlanAction,
    aiTerminalContext,
    onFilePathLinkClick,
    pendingUserInputRequests = [],
    pendingApprovalRequests = [],
    selectedUserInputAnswers,
    submittingUserInputRequestIds = [],
    submittingApprovalRequestIds = [],
    onSelectUserInputOption,
    onChangeUserInputOtherText,
    onSubmitUserInputAnswers,
    onRespondApprovalRequest,
    resolvedUserInputAnswersByItemId,
    suppressedRequestUserInputResultIds,
  } = props;

  const isUser = message.type === "user";
  const isPendingUserTone = isUser && userTone === "pending";
  const planActionHandler = isUser ? undefined : onPlanAction;
  const content = message.message?.content;
  const [agentsExpanded, setAgentsExpanded] = useState(
    searchForcePrimaryExpanded,
  );
  const [agentsViewMode, setAgentsViewMode] =
    useState<JsonViewMode>("formatted");
  const [skillExpanded, setSkillExpanded] = useState(
    searchForcePrimaryExpanded,
  );
  const [skillViewMode, setSkillViewMode] = useState<JsonViewMode>("formatted");

  useEffect(() => {
    if (!searchForcePrimaryExpanded) {
      return;
    }

    setAgentsExpanded(true);
    setSkillExpanded(true);
  }, [searchForcePrimaryExpanded]);

  const shouldForceExpandBlock = (block: ContentBlock): boolean => {
    if (!Array.isArray(content) || searchForceBlockIndex === null) {
      return false;
    }

    return content.indexOf(block) === searchForceBlockIndex;
  };

  if (message.type === "system_error") {
    const systemErrorText = getMessageCopyText(content);
    if (!systemErrorText) {
      return null;
    }

    const title = sanitizeText(message.summary ?? "").trim() || "Error";

    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
        <div className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/30 bg-rose-500/15 px-2 py-1 text-[11px] text-rose-100/95">
          <AlertTriangle size={12} className="opacity-80" />
          <span className="font-medium uppercase tracking-wide">{title}</span>
        </div>
        <div className="mt-2 text-xs leading-relaxed text-rose-100/90">
          <MarkdownRenderer
            content={systemErrorText}
            onFilePathLinkClick={onFilePathLinkClick}
          />
        </div>
      </div>
    );
  }

  if (message.type === "token_limit_notice") {
    const tokenLimitText = getMessageCopyText(content);
    if (!tokenLimitText) {
      return null;
    }

    const title = sanitizeText(message.summary ?? "").trim() || "Rate Limit";
    const repeatCount = getTokenLimitNoticeRepeatCount(message) ?? 1;
    if (repeatCount <= 1) {
      return null;
    }
    const repeatCountMax = Math.max(1, message.repeatCountMax ?? 6);

    return (
      <div className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5">
        <div className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/35 bg-amber-500/15 px-2 py-1 text-[11px] text-amber-100/95">
          <AlertTriangle size={12} className="opacity-80" />
          <span className="font-medium uppercase tracking-wide">
            {title} {repeatCount}/{repeatCountMax}
          </span>
        </div>
        <div className="mt-2 text-xs leading-relaxed text-amber-50/90">
          <MarkdownRenderer
            content={tokenLimitText}
            onFilePathLinkClick={onFilePathLinkClick}
          />
        </div>
      </div>
    );
  }

  if (message.type === "turn_aborted") {
    const turnAbortedText = getTurnAbortedDisplayText(content);
    if (!turnAbortedText) {
      return null;
    }

    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2.5">
        <div className="inline-flex items-center gap-1.5 rounded-md border border-rose-400/30 bg-rose-500/15 px-2 py-1 text-[11px] text-rose-100/95">
          <AlertTriangle size={12} className="opacity-80" />
          <span className="font-medium uppercase tracking-wide">
            Turn Aborted
          </span>
        </div>
        <div className="mt-2 text-xs leading-relaxed text-rose-100/90">
          <MarkdownRenderer
            content={turnAbortedText}
            onFilePathLinkClick={onFilePathLinkClick}
          />
        </div>
      </div>
    );
  }

  const getPrimaryBlocks = (): ContentBlock[] => {
    if (!content || typeof content === "string") {
      return [];
    }
    return content.filter((b) => b.type === "text" || b.type === "image");
  };

  const getAuxiliaryBlocks = (): ContentBlock[] => {
    if (!content || typeof content === "string") {
      return [];
    }

    return content.filter((block) => {
      if (
        block.type === "tool_result" &&
        block.tool_use_id &&
        suppressedRequestUserInputResultIds?.has(block.tool_use_id) &&
        block.is_error !== true
      ) {
        return false;
      }

      return (
        block.type === "tool_use" ||
        block.type === "tool_result" ||
        block.type === "thinking" ||
        block.type === "reasoning" ||
        block.type === "agent_reasoning"
      );
    });
  };

  const getVisiblePrimaryBlocks = (): ContentBlock[] => {
    return getPrimaryBlocks().filter((block) => {
      if (block.type === "text") {
        return !!block.text && sanitizeText(block.text).length > 0;
      }
      return (
        block.type === "image" &&
        typeof block.image_url === "string" &&
        block.image_url.trim().length > 0
      );
    });
  };

  const hasVisiblePrimary = (): boolean => {
    if (typeof content === "string") {
      return sanitizeText(content).length > 0;
    }
    return getVisiblePrimaryBlocks().length > 0;
  };

  const auxiliaryBlocks = getAuxiliaryBlocks();
  const visiblePrimaryBlocks = getVisiblePrimaryBlocks();
  const hasPrimary = hasVisiblePrimary();
  const hasAuxiliary = auxiliaryBlocks.length > 0;
  const messageCopyText = getMessageCopyText(content);
  const rawMessageText = getMessageRawText(content);
  const showMessageCopyButton =
    (isUser || message.type === "assistant") && !!messageCopyText;
  const terminalUserFeedback = isUser
    ? parseAiTerminalUserFeedback(rawMessageText ?? "")
    : null;
  const terminalBootstrap = isUser
    ? parseAiTerminalBootstrapMessage(rawMessageText ?? "")
    : null;
  const terminalCommandOutput =
    isUser && !terminalBootstrap
      ? parseAiTerminalCommandOutputMessage(rawMessageText ?? "")
      : null;

  const toolMap = Array.isArray(content)
    ? buildToolMap(content)
    : new Map<string, string>();
  const toolInputMap = Array.isArray(content)
    ? buildToolInputMap(content)
    : new Map<string, Record<string, unknown>>();
  const toolTimestampMap = Array.isArray(content)
    ? buildToolTimestampMap(content)
    : new Map<string, string>();
  const pendingUserInputRequestByItemId = new Map<
    string,
    CodexUserInputRequest
  >();
  for (const request of pendingUserInputRequests) {
    if (request.itemId) {
      pendingUserInputRequestByItemId.set(request.itemId, request);
    }
  }
  const pendingApprovalRequestByItemId = new Map<
    string,
    CodexApprovalRequest
  >();
  for (const request of pendingApprovalRequests) {
    if (request.itemId) {
      pendingApprovalRequestByItemId.set(request.itemId, request);
    }
  }
  const submittingRequestIdSet = new Set(submittingUserInputRequestIds);
  const submittingApprovalRequestIdSet = new Set(submittingApprovalRequestIds);

  if (!hasPrimary && hasAuxiliary) {
    return (
      <div className="flex flex-col gap-1 py-0.5">
        {auxiliaryBlocks.map((block, index) => (
          <ContentBlockRenderer
            key={index}
            block={block}
            blockIndex={Array.isArray(content) ? content.indexOf(block) : null}
            forceExpanded={shouldForceExpandBlock(block)}
            toolMap={toolMap}
            toolInputMap={toolInputMap}
            toolTimestampMap={toolTimestampMap}
            fallbackToolMap={fallbackToolMap}
            fallbackToolInputMap={fallbackToolInputMap}
            fallbackToolTimestampMap={fallbackToolTimestampMap}
            onPlanAction={planActionHandler}
            aiTerminalContext={aiTerminalContext}
            pendingUserInputRequestByItemId={pendingUserInputRequestByItemId}
            pendingApprovalRequestByItemId={pendingApprovalRequestByItemId}
            selectedUserInputAnswers={selectedUserInputAnswers}
            resolvedUserInputAnswersByItemId={resolvedUserInputAnswersByItemId}
            submittingUserInputRequestIds={submittingRequestIdSet}
            submittingApprovalRequestIds={submittingApprovalRequestIdSet}
            onSelectUserInputOption={onSelectUserInputOption}
            onChangeUserInputOtherText={onChangeUserInputOtherText}
            onSubmitUserInputAnswers={onSubmitUserInputAnswers}
            onRespondApprovalRequest={onRespondApprovalRequest}
          />
        ))}
      </div>
    );
  }

  if (!hasPrimary && !hasAuxiliary && !terminalCommandOutput) {
    return null;
  }

  if (isUser && isAgentsBootstrap) {
    const agentsContent = extractAgentsInstructionsContent(
      messageCopyText ?? "",
    );
    const previewText = getCollapsedPreviewLines(agentsContent, 3);
    const showAgentsRawToggle = agentsExpanded && !!agentsContent;

    return (
      <div className="flex justify-start min-w-0">
        <div
          className={
            agentsExpanded
              ? "max-w-[92%] min-w-0 w-full"
              : "inline-block max-w-[92%] min-w-0"
          }
        >
          <div
            className={`overflow-hidden rounded-2xl border border-zinc-700/70 bg-zinc-900/80 ${
              agentsExpanded ? "w-full" : "inline-block max-w-full"
            }`}
          >
            <div
              className={`items-center gap-2 border-b border-zinc-700/60 px-3 py-2 text-[11px] text-zinc-200 ${
                agentsExpanded ? "flex" : "inline-flex"
              }`}
            >
              <button
                type="button"
                onClick={() => setAgentsExpanded((current) => !current)}
                className={`min-w-0 items-center gap-2 text-left transition-colors hover:text-zinc-100 ${
                  agentsExpanded ? "flex flex-1" : "inline-flex"
                }`}
              >
                <FileCode size={13} className="opacity-70" />
                <span className="font-semibold tracking-wide text-zinc-100">
                  AGENTS.md
                </span>
                <span className="truncate text-zinc-400">
                  Session instructions
                </span>
                <span className="text-[10px] opacity-50">
                  {agentsExpanded ? "▼" : "▶"}
                </span>
              </button>
              {agentsExpanded && showMessageCopyButton && agentsContent && (
                <CopyButton
                  text={agentsContent}
                  title="Copy message"
                  className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 hover:bg-zinc-800/70"
                />
              )}
              {showAgentsRawToggle && (
                <button
                  type="button"
                  onClick={() =>
                    setAgentsViewMode((current) =>
                      current === "formatted" ? "raw" : "formatted",
                    )
                  }
                  className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                    agentsViewMode === "raw"
                      ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                      : "border-zinc-700/70 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/70"
                  }`}
                  title={
                    agentsViewMode === "raw"
                      ? "Show formatted view"
                      : "Show raw text"
                  }
                >
                  {"</>"}
                </button>
              )}
            </div>

            <div className="px-3.5 py-2.5">
              {agentsExpanded ? (
                agentsViewMode === "raw" ? (
                  <pre className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
                    {agentsContent}
                  </pre>
                ) : (
                  <MarkdownRenderer
                    content={sanitizeText(agentsContent)}
                    onFilePathLinkClick={onFilePathLinkClick}
                  />
                )
              ) : (
                <pre className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
                  {previewText}
                </pre>
              )}
            </div>
          </div>

          {hasAuxiliary && (
            <div className="flex flex-col gap-1 mt-1.5">
              {auxiliaryBlocks.map((block, index) => (
                <ContentBlockRenderer
                  key={index}
                  block={block}
                  blockIndex={
                    Array.isArray(content) ? content.indexOf(block) : null
                  }
                  forceExpanded={shouldForceExpandBlock(block)}
                  toolMap={toolMap}
                  toolInputMap={toolInputMap}
                  toolTimestampMap={toolTimestampMap}
                  fallbackToolMap={fallbackToolMap}
                  fallbackToolInputMap={fallbackToolInputMap}
                  fallbackToolTimestampMap={fallbackToolTimestampMap}
                  onPlanAction={planActionHandler}
                  aiTerminalContext={aiTerminalContext}
                  pendingUserInputRequestByItemId={
                    pendingUserInputRequestByItemId
                  }
                  pendingApprovalRequestByItemId={
                    pendingApprovalRequestByItemId
                  }
                  selectedUserInputAnswers={selectedUserInputAnswers}
                  resolvedUserInputAnswersByItemId={
                    resolvedUserInputAnswersByItemId
                  }
                  submittingUserInputRequestIds={submittingRequestIdSet}
                  submittingApprovalRequestIds={submittingApprovalRequestIdSet}
                  onSelectUserInputOption={onSelectUserInputOption}
                  onChangeUserInputOtherText={onChangeUserInputOtherText}
                  onSubmitUserInputAnswers={onSubmitUserInputAnswers}
                  onRespondApprovalRequest={onRespondApprovalRequest}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (isUser && terminalUserFeedback && rawMessageText) {
    return (
      <div className="min-w-0">
        <AiTerminalUserFeedbackRenderer
          feedback={terminalUserFeedback}
          copyText={rawMessageText}
          onFilePathLinkClick={onFilePathLinkClick}
        />

        {hasAuxiliary && (
          <div className="flex flex-col gap-1 mt-1.5">
            {auxiliaryBlocks.map((block, index) => (
              <ContentBlockRenderer
                key={index}
                block={block}
                blockIndex={
                  Array.isArray(content) ? content.indexOf(block) : null
                }
                forceExpanded={shouldForceExpandBlock(block)}
                toolMap={toolMap}
                toolInputMap={toolInputMap}
                toolTimestampMap={toolTimestampMap}
                fallbackToolMap={fallbackToolMap}
                fallbackToolInputMap={fallbackToolInputMap}
                fallbackToolTimestampMap={fallbackToolTimestampMap}
                onPlanAction={planActionHandler}
                aiTerminalContext={aiTerminalContext}
                onFilePathLinkClick={onFilePathLinkClick}
                pendingUserInputRequestByItemId={
                  pendingUserInputRequestByItemId
                }
                pendingApprovalRequestByItemId={pendingApprovalRequestByItemId}
                selectedUserInputAnswers={selectedUserInputAnswers}
                resolvedUserInputAnswersByItemId={
                  resolvedUserInputAnswersByItemId
                }
                submittingUserInputRequestIds={submittingRequestIdSet}
                submittingApprovalRequestIds={submittingApprovalRequestIdSet}
                onSelectUserInputOption={onSelectUserInputOption}
                onChangeUserInputOtherText={onChangeUserInputOtherText}
                onSubmitUserInputAnswers={onSubmitUserInputAnswers}
                onRespondApprovalRequest={onRespondApprovalRequest}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isUser && terminalBootstrap && rawMessageText) {
    return (
      <div className="min-w-0">
        <AiTerminalBootstrapRenderer
          bootstrap={terminalBootstrap}
          copyText={rawMessageText}
          onFilePathLinkClick={onFilePathLinkClick}
        />

        {hasAuxiliary && (
          <div className="flex flex-col gap-1 mt-1.5">
            {auxiliaryBlocks.map((block, index) => (
              <ContentBlockRenderer
                key={index}
                block={block}
                blockIndex={
                  Array.isArray(content) ? content.indexOf(block) : null
                }
                forceExpanded={shouldForceExpandBlock(block)}
                toolMap={toolMap}
                toolInputMap={toolInputMap}
                toolTimestampMap={toolTimestampMap}
                fallbackToolMap={fallbackToolMap}
                fallbackToolInputMap={fallbackToolInputMap}
                fallbackToolTimestampMap={fallbackToolTimestampMap}
                onPlanAction={planActionHandler}
                aiTerminalContext={aiTerminalContext}
                onFilePathLinkClick={onFilePathLinkClick}
                pendingUserInputRequestByItemId={
                  pendingUserInputRequestByItemId
                }
                pendingApprovalRequestByItemId={pendingApprovalRequestByItemId}
                selectedUserInputAnswers={selectedUserInputAnswers}
                resolvedUserInputAnswersByItemId={
                  resolvedUserInputAnswersByItemId
                }
                submittingUserInputRequestIds={submittingRequestIdSet}
                submittingApprovalRequestIds={submittingApprovalRequestIdSet}
                onSelectUserInputOption={onSelectUserInputOption}
                onChangeUserInputOtherText={onChangeUserInputOtherText}
                onSubmitUserInputAnswers={onSubmitUserInputAnswers}
                onRespondApprovalRequest={onRespondApprovalRequest}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isUser && terminalCommandOutput && rawMessageText) {
    return (
      <div className="min-w-0">
        <AiTerminalCommandOutputRenderer
          message={terminalCommandOutput}
          copyText={rawMessageText}
          onFilePathLinkClick={onFilePathLinkClick}
        />

        {hasAuxiliary && (
          <div className="flex flex-col gap-1 mt-1.5">
            {auxiliaryBlocks.map((block, index) => (
              <ContentBlockRenderer
                key={index}
                block={block}
                blockIndex={
                  Array.isArray(content) ? content.indexOf(block) : null
                }
                forceExpanded={shouldForceExpandBlock(block)}
                toolMap={toolMap}
                toolInputMap={toolInputMap}
                toolTimestampMap={toolTimestampMap}
                fallbackToolMap={fallbackToolMap}
                fallbackToolInputMap={fallbackToolInputMap}
                fallbackToolTimestampMap={fallbackToolTimestampMap}
                onPlanAction={planActionHandler}
                aiTerminalContext={aiTerminalContext}
                onFilePathLinkClick={onFilePathLinkClick}
                pendingUserInputRequestByItemId={
                  pendingUserInputRequestByItemId
                }
                pendingApprovalRequestByItemId={pendingApprovalRequestByItemId}
                selectedUserInputAnswers={selectedUserInputAnswers}
                resolvedUserInputAnswersByItemId={
                  resolvedUserInputAnswersByItemId
                }
                submittingUserInputRequestIds={submittingRequestIdSet}
                submittingApprovalRequestIds={submittingApprovalRequestIdSet}
                onSelectUserInputOption={onSelectUserInputOption}
                onChangeUserInputOtherText={onChangeUserInputOtherText}
                onSubmitUserInputAnswers={onSubmitUserInputAnswers}
                onRespondApprovalRequest={onRespondApprovalRequest}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (isUser) {
    const skillBlock = extractSkillBlockContent(messageCopyText ?? "");
    if (skillBlock) {
      const skillPathTail = skillBlock.path ? getPathTail(skillBlock.path) : "";
      const headerDetail = skillBlock.name
        ? skillPathTail
          ? `$${skillBlock.name} · ${skillPathTail}`
          : `$${skillBlock.name}`
        : skillPathTail || "Session skill instructions";
      const previewSource = [
        skillBlock.name ? `Name: ${skillBlock.name}` : "",
        skillBlock.path ? `Path: ${skillBlock.path}` : "",
        skillBlock.markdownContent,
      ]
        .filter((part) => part.length > 0)
        .join("\n");
      const previewText = getCollapsedPreviewLines(previewSource, 3);
      const showSkillRawToggle = skillExpanded && !!skillBlock.rawContent;

      return (
        <div className="flex justify-start min-w-0">
          <div
            className={
              skillExpanded
                ? "max-w-[92%] min-w-0 w-full"
                : "inline-block max-w-[92%] min-w-0"
            }
          >
            <div
              className={`overflow-hidden rounded-2xl border border-zinc-700/70 bg-zinc-900/80 ${
                skillExpanded ? "w-full" : "inline-block max-w-full"
              }`}
            >
              <div
                className={`items-center gap-2 border-b border-zinc-700/60 px-3 py-2 text-[11px] text-zinc-200 ${
                  skillExpanded ? "flex" : "inline-flex"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSkillExpanded((current) => !current)}
                  className={`min-w-0 items-center gap-2 text-left transition-colors hover:text-zinc-100 ${
                    skillExpanded ? "flex flex-1" : "inline-flex"
                  }`}
                  title={skillBlock.path ?? undefined}
                >
                  <FileCode size={13} className="opacity-70" />
                  <span className="font-semibold tracking-wide text-zinc-100">
                    Skill
                  </span>
                  <span className="truncate text-zinc-400">{headerDetail}</span>
                  <span className="text-[10px] opacity-50">
                    {skillExpanded ? "▼" : "▶"}
                  </span>
                </button>
                {skillExpanded && showMessageCopyButton && (
                  <CopyButton
                    text={skillBlock.rawContent}
                    title="Copy skill block"
                    className="rounded-lg border border-zinc-700/70 bg-zinc-900/70 hover:bg-zinc-800/70"
                  />
                )}
                {showSkillRawToggle && (
                  <button
                    type="button"
                    onClick={() =>
                      setSkillViewMode((current) =>
                        current === "formatted" ? "raw" : "formatted",
                      )
                    }
                    className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                      skillViewMode === "raw"
                        ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                        : "border-zinc-700/70 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/70"
                    }`}
                    title={
                      skillViewMode === "raw"
                        ? "Show formatted view"
                        : "Show raw text"
                    }
                  >
                    {"</>"}
                  </button>
                )}
              </div>

              <div className="px-3.5 py-2.5">
                {skillExpanded ? (
                  skillViewMode === "raw" ? (
                    <pre className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
                      {skillBlock.rawContent}
                    </pre>
                  ) : (
                    <>
                      {(skillBlock.name || skillBlock.path) && (
                        <div className="mb-2 space-y-1 rounded-lg border border-zinc-700/60 bg-zinc-950/60 px-2.5 py-2 text-[11px] text-zinc-300">
                          {skillBlock.name && (
                            <div className="flex gap-1.5">
                              <span className="text-zinc-500">Name:</span>
                              <span className="font-mono text-zinc-200">
                                {skillBlock.name}
                              </span>
                            </div>
                          )}
                          {skillBlock.path && (
                            <div className="flex min-w-0 gap-1.5">
                              <span className="shrink-0 text-zinc-500">
                                Path:
                              </span>
                              <span
                                className="min-w-0 truncate font-mono text-zinc-200"
                                title={skillBlock.path}
                              >
                                {skillBlock.path}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                      <MarkdownRenderer
                        content={sanitizeText(skillBlock.markdownContent)}
                        onFilePathLinkClick={onFilePathLinkClick}
                      />
                    </>
                  )
                ) : (
                  <pre className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-300">
                    {previewText}
                  </pre>
                )}
              </div>
            </div>

            {hasAuxiliary && (
              <div className="flex flex-col gap-1 mt-1.5">
                {auxiliaryBlocks.map((block, index) => (
                  <ContentBlockRenderer
                    key={index}
                    block={block}
                    blockIndex={
                      Array.isArray(content) ? content.indexOf(block) : null
                    }
                    forceExpanded={shouldForceExpandBlock(block)}
                    toolMap={toolMap}
                    toolInputMap={toolInputMap}
                    toolTimestampMap={toolTimestampMap}
                    fallbackToolMap={fallbackToolMap}
                    fallbackToolInputMap={fallbackToolInputMap}
                    fallbackToolTimestampMap={fallbackToolTimestampMap}
                    onPlanAction={planActionHandler}
                    aiTerminalContext={aiTerminalContext}
                    pendingUserInputRequestByItemId={
                      pendingUserInputRequestByItemId
                    }
                    pendingApprovalRequestByItemId={
                      pendingApprovalRequestByItemId
                    }
                    selectedUserInputAnswers={selectedUserInputAnswers}
                    resolvedUserInputAnswersByItemId={
                      resolvedUserInputAnswersByItemId
                    }
                    submittingUserInputRequestIds={submittingRequestIdSet}
                    submittingApprovalRequestIds={
                      submittingApprovalRequestIdSet
                    }
                    onSelectUserInputOption={onSelectUserInputOption}
                    onChangeUserInputOtherText={onChangeUserInputOtherText}
                    onSubmitUserInputAnswers={onSubmitUserInputAnswers}
                    onRespondApprovalRequest={onRespondApprovalRequest}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} min-w-0`}>
      <div className="max-w-[85%] min-w-0">
        <div className="group relative">
          <div
            className={`px-3.5 py-2.5 rounded-2xl overflow-hidden ${
              isUser
                ? isPendingUserTone
                  ? "bg-zinc-700/60 text-zinc-100 rounded-br-md"
                  : "bg-indigo-600/80 text-indigo-50 rounded-br-md"
                : "bg-cyan-700/50 text-zinc-100 rounded-bl-md"
            }`}
          >
            {typeof content === "string" ? (
              (() => {
                const sanitized = sanitizeText(content);
                const aiTerminalMessage = parseAiTerminalMessage(sanitized);
                if (aiTerminalMessage) {
                  return (
                    <AiTerminalDirectiveRenderer
                      directive={aiTerminalMessage.directive}
                      leadingMarkdown={aiTerminalMessage.leadingMarkdown}
                      trailingMarkdown={aiTerminalMessage.trailingMarkdown}
                      aiTerminalContext={aiTerminalContext}
                      onFilePathLinkClick={onFilePathLinkClick}
                    />
                  );
                }
                const proposedPlan = parseProposedPlanBlock(sanitized);
                if (proposedPlan) {
                  return (
                    <ProposedPlanRenderer
                      planMarkdown={proposedPlan.planMarkdown}
                      trailingMarkdown={proposedPlan.trailingMarkdown}
                      onPlanAction={planActionHandler}
                      onFilePathLinkClick={onFilePathLinkClick}
                    />
                  );
                }
                return (
                  <MarkdownRenderer
                    content={sanitized}
                    onFilePathLinkClick={onFilePathLinkClick}
                  />
                );
              })()
            ) : (
              <div className="flex flex-col gap-1">
                {visiblePrimaryBlocks.map((block, index) => (
                  <ContentBlockRenderer
                    key={index}
                    block={block}
                    blockIndex={
                      Array.isArray(content) ? content.indexOf(block) : null
                    }
                    forceExpanded={shouldForceExpandBlock(block)}
                    toolMap={toolMap}
                    toolInputMap={toolInputMap}
                    toolTimestampMap={toolTimestampMap}
                    fallbackToolMap={fallbackToolMap}
                    fallbackToolInputMap={fallbackToolInputMap}
                    fallbackToolTimestampMap={fallbackToolTimestampMap}
                    onPlanAction={planActionHandler}
                    aiTerminalContext={aiTerminalContext}
                    onFilePathLinkClick={onFilePathLinkClick}
                    pendingUserInputRequestByItemId={
                      pendingUserInputRequestByItemId
                    }
                    pendingApprovalRequestByItemId={
                      pendingApprovalRequestByItemId
                    }
                    selectedUserInputAnswers={selectedUserInputAnswers}
                    resolvedUserInputAnswersByItemId={
                      resolvedUserInputAnswersByItemId
                    }
                    submittingUserInputRequestIds={submittingRequestIdSet}
                    submittingApprovalRequestIds={
                      submittingApprovalRequestIdSet
                    }
                    onSelectUserInputOption={onSelectUserInputOption}
                    onChangeUserInputOtherText={onChangeUserInputOtherText}
                    onSubmitUserInputAnswers={onSubmitUserInputAnswers}
                    onRespondApprovalRequest={onRespondApprovalRequest}
                  />
                ))}
              </div>
            )}
          </div>
          {showMessageCopyButton && messageCopyText && (
            <CopyButton
              text={messageCopyText}
              title="Copy message"
              className={`absolute right-2 top-2 rounded-lg border opacity-0 transition-opacity group-hover:opacity-100 ${
                isUser
                  ? isPendingUserTone
                    ? "border-zinc-400/30 bg-zinc-900/55"
                    : "border-indigo-300/35 bg-indigo-900/45"
                  : "border-cyan-300/35 bg-cyan-900/35"
              }`}
            />
          )}
        </div>

        {hasAuxiliary && (
          <div className="flex flex-col gap-1 mt-1.5">
            {auxiliaryBlocks.map((block, index) => (
              <ContentBlockRenderer
                key={index}
                block={block}
                blockIndex={
                  Array.isArray(content) ? content.indexOf(block) : null
                }
                forceExpanded={shouldForceExpandBlock(block)}
                toolMap={toolMap}
                toolInputMap={toolInputMap}
                toolTimestampMap={toolTimestampMap}
                fallbackToolMap={fallbackToolMap}
                fallbackToolInputMap={fallbackToolInputMap}
                fallbackToolTimestampMap={fallbackToolTimestampMap}
                onPlanAction={planActionHandler}
                aiTerminalContext={aiTerminalContext}
                onFilePathLinkClick={onFilePathLinkClick}
                pendingUserInputRequestByItemId={
                  pendingUserInputRequestByItemId
                }
                pendingApprovalRequestByItemId={pendingApprovalRequestByItemId}
                selectedUserInputAnswers={selectedUserInputAnswers}
                resolvedUserInputAnswersByItemId={
                  resolvedUserInputAnswersByItemId
                }
                submittingUserInputRequestIds={submittingRequestIdSet}
                submittingApprovalRequestIds={submittingApprovalRequestIdSet}
                onSelectUserInputOption={onSelectUserInputOption}
                onChangeUserInputOtherText={onChangeUserInputOtherText}
                onSubmitUserInputAnswers={onSubmitUserInputAnswers}
                onRespondApprovalRequest={onRespondApprovalRequest}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

interface ContentBlockRendererProps {
  block: ContentBlock;
  blockIndex?: number | null;
  forceExpanded?: boolean;
  toolMap?: Map<string, string>;
  toolInputMap?: Map<string, Record<string, unknown>>;
  toolTimestampMap?: Map<string, string>;
  fallbackToolMap?: Map<string, string>;
  fallbackToolInputMap?: Map<string, Record<string, unknown>>;
  fallbackToolTimestampMap?: Map<string, string>;
  onPlanAction?: (action: "implement" | "stay") => void;
  aiTerminalContext?: MessageBlockProps["aiTerminalContext"];
  onFilePathLinkClick?: (href: string) => boolean;
  pendingUserInputRequestByItemId?: Map<string, CodexUserInputRequest>;
  pendingApprovalRequestByItemId?: Map<string, CodexApprovalRequest>;
  selectedUserInputAnswers?: Record<
    string,
    Record<
      string,
      {
        optionLabel: string;
        otherText: string;
      }
    >
  >;
  resolvedUserInputAnswersByItemId?: Map<
    string,
    Record<
      string,
      {
        optionLabel: string;
        otherText: string;
      }
    >
  >;
  submittingUserInputRequestIds?: Set<string>;
  submittingApprovalRequestIds?: Set<string>;
  onSelectUserInputOption?: (
    request: CodexUserInputRequest,
    questionId: string,
    optionLabel: string,
  ) => void;
  onChangeUserInputOtherText?: (
    request: CodexUserInputRequest,
    questionId: string,
    text: string,
  ) => void;
  onSubmitUserInputAnswers?: (request: CodexUserInputRequest) => void;
  onRespondApprovalRequest?: (
    request: CodexApprovalRequest,
    response: CodexApprovalResponsePayload,
  ) => void;
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  todowrite: ListTodo,
  read: FileCode,
  bash: Terminal,
  grep: Search,
  edit: Pencil,
  write: FilePlus2,
  glob: FolderOpen,
  task: Bot,
  exec_command: Terminal,
  write_stdin: Terminal,
  apply_patch: Pencil,
  update_plan: ListTodo,
  js_repl: FileCode,
  js_repl_reset: FileCode,
  spawn_agent: Bot,
  wait: Bot,
  close_agent: Bot,
  request_user_input: MessageSquare,
  view_image: ImageIcon,
};

const TOOL_ICON_PATTERNS: Array<{ patterns: string[]; icon: typeof Wrench }> = [
  { patterns: ["web", "fetch", "url"], icon: Globe },
  { patterns: ["ask", "question"], icon: MessageSquare },
  { patterns: ["git", "commit"], icon: GitBranch },
  { patterns: ["sql", "database", "query"], icon: Database },
  { patterns: ["file", "disk"], icon: HardDrive },
];

function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase();

  if (TOOL_ICONS[name]) {
    return TOOL_ICONS[name];
  }

  for (const { patterns, icon } of TOOL_ICON_PATTERNS) {
    if (patterns.some((p) => name.includes(p))) {
      return icon;
    }
  }

  return Wrench;
}

function getFilePathPreview(filePath: string): string {
  return getPathTail(filePath);
}

type PreviewHandler = (input: Record<string, unknown>) => string | null;

function getTruncatedPreview(value: string, maxLength: number = 120): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function hasMultipleLines(value: string): boolean {
  return /\r?\n/.test(value.trim());
}

function withMultilineCollapsedIndicator(
  preview: string,
  source: string,
): string {
  if (!preview) {
    return preview;
  }

  if (!hasMultipleLines(source)) {
    return preview;
  }

  return preview.endsWith("...") ? preview : `${preview}...`;
}

function getApplyPatchPreview(raw: string): string | null {
  const match = raw.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
  if (!match) {
    return null;
  }

  return getFilePathPreview(match[1].trim());
}

function getPatchTypePillClassName(fileType: string): string {
  if (fileType.toLowerCase() === "markdown") {
    return "border border-emerald-400/40 bg-emerald-500/18 text-emerald-200";
  }
  return "border border-zinc-600/60 bg-zinc-800/40 text-zinc-300";
}

function ApplyPatchInputRenderer(props: {
  raw: string;
  embedded?: boolean;
  hideHeader?: boolean;
  onFilePathLinkClick?: (href: string) => boolean;
}) {
  const {
    raw,
    embedded = false,
    hideHeader = false,
    onFilePathLinkClick,
  } = props;
  const fileTypes = getPatchFileTypes(raw);
  const visibleFileTypes = fileTypes.slice(0, 3);
  const hiddenFileTypeCount = Math.max(
    fileTypes.length - visibleFileTypes.length,
    0,
  );

  return (
    <div
      className={`overflow-hidden ${embedded ? "rounded-md border border-zinc-700/45 bg-zinc-950/70" : "rounded-lg border border-zinc-700/60 bg-zinc-950/80"}`}
    >
      {!hideHeader && (
        <div
          className={`flex items-center justify-between border-b border-zinc-700/50 px-3 py-1.5 ${embedded ? "bg-zinc-900/55" : "bg-zinc-900/70"}`}
        >
          <span className="text-[10px] font-mono text-zinc-400">
            apply_patch
          </span>
          <div className="flex min-w-0 items-center justify-end gap-1 overflow-hidden">
            {visibleFileTypes.length === 0 ? (
              <span className="text-[10px] font-mono text-zinc-500">Patch</span>
            ) : (
              visibleFileTypes.map((fileType) => (
                <span
                  key={fileType}
                  className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[9px] font-semibold ${getPatchTypePillClassName(
                    fileType,
                  )}`}
                >
                  {fileType}
                </span>
              ))
            )}
            {hiddenFileTypeCount > 0 ? (
              <span className="text-[10px] font-mono text-zinc-500">
                +{hiddenFileTypeCount}
              </span>
            ) : null}
          </div>
        </div>
      )}
      <div className="max-w-full text-[11px]">
        <PatchTextRenderer
          raw={raw}
          maxHeightClassName="max-h-[420px]"
          onFilePathLinkClick={onFilePathLinkClick}
        />
      </div>
    </div>
  );
}

type NormalizedTodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

function normalizeTodoStatus(value: unknown): NormalizedTodoItem["status"] {
  if (value === "completed" || value === "in_progress" || value === "pending") {
    return value;
  }
  return "pending";
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getTodoItemsFromInput(
  input: Record<string, unknown>,
): NormalizedTodoItem[] {
  if (Array.isArray(input.todos)) {
    return input.todos
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        content:
          typeof item.content === "string" && item.content.trim().length > 0
            ? item.content
            : "(empty step)",
        status: normalizeTodoStatus(item.status),
      }));
  }

  if (Array.isArray(input.plan)) {
    return input.plan
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        content:
          typeof item.step === "string" && item.step.trim().length > 0
            ? item.step
            : "(empty step)",
        status: normalizeTodoStatus(item.status),
      }));
  }

  return [];
}

function toAskQuestionInput(input: Record<string, unknown>): {
  requestId?: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
    isOther: boolean;
    isSecret: boolean;
  }>;
} {
  if (!Array.isArray(input.questions)) {
    return { questions: [] };
  }

  const questions = input.questions
    .filter((question): question is Record<string, unknown> =>
      isRecord(question),
    )
    .map((question, index) => {
      const options = Array.isArray(question.options)
        ? question.options
            .filter((option): option is Record<string, unknown> =>
              isRecord(option),
            )
            .map((option) => ({
              label:
                typeof option.label === "string" &&
                option.label.trim().length > 0
                  ? option.label
                  : "Option",
              description:
                typeof option.description === "string"
                  ? option.description
                  : "",
            }))
        : [];

      return {
        id:
          typeof question.id === "string" && question.id.trim().length > 0
            ? question.id
            : `question-${index}`,
        header:
          typeof question.header === "string" &&
          question.header.trim().length > 0
            ? question.header
            : "Question",
        question:
          typeof question.question === "string" &&
          question.question.trim().length > 0
            ? question.question
            : "",
        options,
        multiSelect: question.multiSelect === true,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
      };
    })
    .filter((question) => question.question.length > 0);

  return { questions };
}

function summarizeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    if (!value.trim()) {
      return "(empty)";
    }
    return value.length > 140 ? `${value.slice(0, 140)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }
  if (isRecord(value)) {
    return `${Object.keys(value).length} field(s)`;
  }
  return String(value);
}

function GenericToolInputRenderer(props: {
  input: Record<string, unknown>;
  embedded?: boolean;
  hideHeader?: boolean;
}) {
  const entries = Object.entries(props.input);
  const { embedded = false, hideHeader = false } = props;

  if (entries.length === 0) {
    return (
      <div
        className={`${embedded ? "rounded-md bg-zinc-900/40" : "rounded-lg border border-zinc-700/50 bg-zinc-900/70"} px-3 py-2 text-xs text-zinc-500`}
      >
        No input arguments
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden ${embedded ? "rounded-md bg-zinc-900/40" : "rounded-lg border border-zinc-700/50 bg-zinc-900/70"}`}
    >
      {!hideHeader && (
        <div
          className={`border-b border-zinc-700/50 px-3 py-2 text-xs font-medium text-zinc-300 ${embedded ? "bg-zinc-800/25" : "bg-zinc-800/30"}`}
        >
          Parameters
        </div>
      )}
      <div className="divide-y divide-zinc-800/50">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start gap-3 px-3 py-2 text-xs">
            <span className="w-36 shrink-0 font-mono text-zinc-500">{key}</span>
            <span className="whitespace-pre-wrap break-all text-zinc-300">
              {summarizeValue(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function getRawToolInputValue(
  block: ContentBlock,
  input: Record<string, unknown>,
): unknown {
  return {
    type: block.type,
    id: block.id,
    name: block.name,
    input,
  };
}

function renderFormattedToolInput(
  block: ContentBlock,
  input: Record<string, unknown>,
  embedded: boolean,
  hideHeader: boolean,
  onFilePathLinkClick?: (href: string) => boolean,
  requestUserInputRequest?: CodexUserInputRequest,
  selectedUserInputAnswers?: Record<
    string,
    {
      optionLabel: string;
      otherText: string;
    }
  >,
  submittingUserInputRequest = false,
  onSelectUserInputOption?: (
    request: CodexUserInputRequest,
    questionId: string,
    optionLabel: string,
  ) => void,
  onChangeUserInputOtherText?: (
    request: CodexUserInputRequest,
    questionId: string,
    text: string,
  ) => void,
  onSubmitUserInputAnswers?: (request: CodexUserInputRequest) => void,
): JSX.Element {
  const toolName = (block.name || "").toLowerCase();
  const rawInput = typeof input.raw === "string" ? input.raw : null;

  if (toolName === "apply_patch" && rawInput) {
    return (
      <ApplyPatchInputRenderer
        raw={rawInput}
        embedded={embedded}
        hideHeader={hideHeader}
        onFilePathLinkClick={onFilePathLinkClick}
      />
    );
  }

  if (
    (toolName === "bash" ||
      toolName === "exec_command" ||
      toolName === "write_stdin") &&
    (typeof input.command === "string" ||
      typeof input.cmd === "string" ||
      typeof input.chars === "string")
  ) {
    const command =
      typeof input.command === "string"
        ? input.command
        : typeof input.cmd === "string"
          ? input.cmd
          : String(input.chars ?? "");
    if (command.length > 0) {
      const description =
        typeof input.description === "string"
          ? input.description
          : typeof input.session_id === "number"
            ? `session ${input.session_id}`
            : undefined;

      return (
        <BashRenderer
          input={{ command, description }}
          embedded={embedded}
          hideHeader={hideHeader}
        />
      );
    }
  }

  if (toolName === "read" && typeof input.file_path === "string") {
    return (
      <ReadRenderer
        input={{
          file_path: input.file_path,
          offset: asOptionalNumber(input.offset),
          limit: asOptionalNumber(input.limit),
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "grep" && typeof input.pattern === "string") {
    return (
      <GrepRenderer
        input={{
          pattern: input.pattern,
          path: asOptionalString(input.path),
          glob: asOptionalString(input.glob),
          type: asOptionalString(input.type),
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "glob" && typeof input.pattern === "string") {
    return (
      <GlobRenderer
        input={{
          pattern: input.pattern,
          path: asOptionalString(input.path),
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "edit" && typeof input.file_path === "string") {
    return (
      <EditRenderer
        input={{
          file_path: input.file_path,
          old_string:
            typeof input.old_string === "string" ? input.old_string : "",
          new_string:
            typeof input.new_string === "string" ? input.new_string : "",
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "write" && typeof input.file_path === "string") {
    return (
      <WriteRenderer
        input={{
          file_path: input.file_path,
          content:
            typeof input.content === "string"
              ? input.content
              : stringifyJson(input.content),
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "update_plan" || toolName === "todowrite") {
    const todos = getTodoItemsFromInput(input);
    if (todos.length > 0) {
      return (
        <TodoRenderer
          todos={todos}
          embedded={embedded}
          hideHeader={hideHeader}
        />
      );
    }
  }

  if (toolName === "request_user_input" || toolName === "askuserquestion") {
    const normalizedInput = toAskQuestionInput(input);
    if (normalizedInput.questions.length > 0) {
      return (
        <AskQuestionRenderer
          input={normalizedInput}
          embedded={embedded}
          hideHeader={hideHeader}
          selectedAnswers={selectedUserInputAnswers}
          submitting={submittingUserInputRequest}
          onSelectOption={
            requestUserInputRequest && onSelectUserInputOption
              ? (questionId, optionLabel) =>
                  onSelectUserInputOption(
                    requestUserInputRequest,
                    questionId,
                    optionLabel,
                  )
              : undefined
          }
          onChangeOtherText={
            requestUserInputRequest && onChangeUserInputOtherText
              ? (questionId, text) =>
                  onChangeUserInputOtherText(
                    requestUserInputRequest,
                    questionId,
                    text,
                  )
              : undefined
          }
          onSubmitAnswers={
            requestUserInputRequest && onSubmitUserInputAnswers
              ? () => onSubmitUserInputAnswers(requestUserInputRequest)
              : undefined
          }
        />
      );
    }
  }

  if (toolName === "task" || toolName === "spawn_agent") {
    const prompt =
      typeof input.prompt === "string"
        ? input.prompt
        : typeof input.message === "string"
          ? input.message
          : "Task request";
    return (
      <TaskRenderer
        input={{
          description:
            typeof input.description === "string" ? input.description : "",
          prompt,
          subagent_type:
            typeof input.subagent_type === "string"
              ? input.subagent_type
              : typeof input.agent_type === "string"
                ? input.agent_type
                : "default",
          model: asOptionalString(input.model),
          run_in_background: input.run_in_background === true,
          resume:
            typeof input.resume === "string"
              ? input.resume
              : typeof input.id === "string"
                ? input.id
                : undefined,
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  return (
    <GenericToolInputRenderer
      input={input}
      embedded={embedded}
      hideHeader={hideHeader}
    />
  );
}

function renderToolInput(
  block: ContentBlock,
  input: Record<string, unknown>,
  viewMode: JsonViewMode,
  embedded: boolean,
  onFilePathLinkClick?: (href: string) => boolean,
  requestUserInputRequest?: CodexUserInputRequest,
  selectedUserInputAnswers?: Record<
    string,
    {
      optionLabel: string;
      otherText: string;
    }
  >,
  submittingUserInputRequest = false,
  onSelectUserInputOption?: (
    request: CodexUserInputRequest,
    questionId: string,
    optionLabel: string,
  ) => void,
  onChangeUserInputOtherText?: (
    request: CodexUserInputRequest,
    questionId: string,
    text: string,
  ) => void,
  onSubmitUserInputAnswers?: (request: CodexUserInputRequest) => void,
): JSX.Element {
  if (viewMode === "raw") {
    return <JsonRenderer value={getRawToolInputValue(block, input)} />;
  }

  return renderFormattedToolInput(
    block,
    input,
    embedded,
    embedded,
    onFilePathLinkClick,
    requestUserInputRequest,
    selectedUserInputAnswers,
    submittingUserInputRequest,
    onSelectUserInputOption,
    onChangeUserInputOtherText,
    onSubmitUserInputAnswers,
  );
}

const TOOL_PREVIEW_HANDLERS: Record<string, PreviewHandler> = {
  read: (input) =>
    input.file_path ? getFilePathPreview(String(input.file_path)) : null,
  edit: (input) =>
    input.file_path ? getFilePathPreview(String(input.file_path)) : null,
  write: (input) =>
    input.file_path ? getFilePathPreview(String(input.file_path)) : null,
  bash: (input) => {
    if (!input.command) {
      return null;
    }
    const cmd = String(input.command);
    return withMultilineCollapsedIndicator(getTruncatedPreview(cmd, 120), cmd);
  },
  grep: (input) => (input.pattern ? `"${String(input.pattern)}"` : null),
  glob: (input) => (input.pattern ? String(input.pattern) : null),
  task: (input) => (input.description ? String(input.description) : null),
  exec_command: (input) =>
    input.cmd
      ? withMultilineCollapsedIndicator(
          getTruncatedPreview(String(input.cmd)),
          String(input.cmd),
        )
      : null,
  write_stdin: (input) =>
    input.session_id ? `session ${String(input.session_id)}` : null,
  apply_patch: (input) =>
    typeof input.raw === "string"
      ? withMultilineCollapsedIndicator(
          getApplyPatchPreview(input.raw) ?? "",
          input.raw,
        ) || null
      : null,
  update_plan: (input) =>
    Array.isArray(input.plan) ? `${input.plan.length} steps` : null,
  js_repl: (input) =>
    typeof input.raw === "string"
      ? getTruncatedPreview(input.raw.split("\n")[0]?.trim() || "js")
      : null,
  spawn_agent: (input) => {
    if (input.agent_type) {
      return String(input.agent_type);
    }
    if (input.message) {
      const message = String(input.message);
      return withMultilineCollapsedIndicator(
        getTruncatedPreview(message),
        message,
      );
    }
    return null;
  },
  request_user_input: (input) =>
    Array.isArray(input.questions)
      ? `${input.questions.length} question(s)`
      : null,
  wait: (input) =>
    Array.isArray(input.ids) ? `${input.ids.length} agent(s)` : null,
  close_agent: (input) =>
    input.id ? getTruncatedPreview(String(input.id), 24) : null,
  view_image: (input) =>
    input.path ? getFilePathPreview(String(input.path)) : null,
};

function getToolPreview(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input) {
    return null;
  }

  const name = toolName.toLowerCase();
  const handler = TOOL_PREVIEW_HANDLERS[name];

  if (handler) {
    return handler(input);
  }

  if (name.includes("web") && input.url) {
    try {
      const url = new URL(String(input.url));
      return url.hostname;
    } catch {
      return String(input.url).slice(0, 30);
    }
  }

  return null;
}

function getToolCopyText(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input) {
    return null;
  }

  const name = toolName.toLowerCase();
  if (name === "exec_command" || name === "bash") {
    if (typeof input.cmd === "string" && input.cmd.length > 0) {
      return input.cmd;
    }
    if (typeof input.command === "string" && input.command.length > 0) {
      return input.command;
    }
    return null;
  }

  if (name === "write_stdin") {
    return typeof input.chars === "string" && input.chars.length > 0
      ? input.chars
      : null;
  }

  return null;
}

function getToolExpandedLabel(toolName: string): string | null {
  const name = toolName.toLowerCase();
  if (name === "exec_command" || name === "bash" || name === "write_stdin") {
    return "Command";
  }
  return null;
}

interface ToolResultRendererProps {
  toolName: string;
  content: string;
  isError?: boolean;
  command?: string;
  embedded?: boolean;
  hideHeader?: boolean;
  onFilePathLinkClick?: (href: string) => boolean;
}

function parseJsonValue(content: string): { parsed: boolean; value: unknown } {
  const trimmed = content.trim();
  if (!trimmed) {
    return { parsed: false, value: null };
  }

  const startsLikeJson =
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith('"') ||
    trimmed === "null" ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d/.test(trimmed);

  if (!startsLikeJson) {
    return { parsed: false, value: null };
  }

  try {
    return { parsed: true, value: JSON.parse(trimmed) };
  } catch {
    return { parsed: false, value: null };
  }
}

function tryParseJson(content: string): unknown {
  const parsed = parseJsonValue(content);
  return parsed.parsed ? parsed.value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseExecPreview(content: string): string | null {
  const outputMarker = "\nOutput:\n";
  const outputIndex = content.indexOf(outputMarker);
  const body =
    outputIndex >= 0
      ? content.slice(outputIndex + outputMarker.length)
      : content;
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return null;
  }

  return withMultilineCollapsedIndicator(
    getTruncatedPreview(firstLine, 120),
    body,
  );
}

function getExecBody(content: string): string {
  const outputMarker = "\nOutput:\n";
  const outputIndex = content.indexOf(outputMarker);
  return outputIndex >= 0
    ? content.slice(outputIndex + outputMarker.length).trimEnd()
    : content;
}

function getToolResultPreview(
  toolName: string,
  content: string,
): string | null {
  const name = toolName.toLowerCase();
  const parsed = tryParseJson(content);

  if (name === "view_image" && Array.isArray(parsed)) {
    const imageCount = parsed.filter(
      (item) => isRecord(item) && item.type === "input_image",
    ).length;
    return imageCount > 0
      ? `${imageCount} image${imageCount > 1 ? "s" : ""}`
      : null;
  }

  if (name === "spawn_agent" && isRecord(parsed)) {
    if (typeof parsed.nickname === "string") {
      return parsed.nickname;
    }
    if (typeof parsed.agent_id === "string") {
      return getTruncatedPreview(parsed.agent_id, 24);
    }
  }

  if (name === "wait" && isRecord(parsed)) {
    if (typeof parsed.timed_out === "boolean" && parsed.timed_out) {
      return "timed out";
    }
    if (isRecord(parsed.status)) {
      return `${Object.keys(parsed.status).length} status result(s)`;
    }
  }

  if (
    name === "close_agent" &&
    isRecord(parsed) &&
    typeof parsed.status === "string"
  ) {
    return parsed.status;
  }

  if (
    name === "request_user_input" &&
    isRecord(parsed) &&
    isRecord(parsed.answers)
  ) {
    return `${Object.keys(parsed.answers).length} answer set(s)`;
  }

  if (
    name === "apply_patch" &&
    isRecord(parsed) &&
    typeof parsed.output === "string"
  ) {
    const output = parsed.output;
    return withMultilineCollapsedIndicator(
      getTruncatedPreview(output.split("\n")[0]?.trim() || "", 120),
      output,
    );
  }

  if (name === "exec_command" || name === "write_stdin") {
    return parseExecPreview(content);
  }

  return null;
}

function ToolResultRenderer(props: ToolResultRendererProps) {
  return <FunctionToolResultRenderer {...props} />;
}

function getCommandFromToolInput(
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) {
    return undefined;
  }

  if (typeof input.cmd === "string" && input.cmd.trim().length > 0) {
    return input.cmd;
  }

  if (typeof input.command === "string" && input.command.trim().length > 0) {
    return input.command;
  }

  return undefined;
}

function getToolResultRawValue(
  block: ContentBlock,
  toolName: string,
): unknown | null {
  if (typeof block.content === "string") {
    const parsed = parseJsonValue(block.content);
    if (!parsed.parsed) {
      return null;
    }

    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      name: toolName || block.name,
      is_error: block.is_error,
      content: parsed.value,
    };
  }

  if (
    block.content !== undefined &&
    (typeof block.content === "object" ||
      typeof block.content === "number" ||
      typeof block.content === "boolean")
  ) {
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      name: toolName || block.name,
      is_error: block.is_error,
      content: block.content,
    };
  }

  return null;
}

function ApprovalRequestRenderer(props: {
  request: CodexApprovalRequest;
  submitting: boolean;
  onRespond?: (
    request: CodexApprovalRequest,
    response: CodexApprovalResponsePayload,
  ) => void;
}) {
  const { request, submitting, onRespond } = props;

  return (
    <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
      <div className="text-[11px] font-medium text-amber-200">
        Approval required
      </div>
      {request.reason && (
        <div className="mt-1 text-[11px] text-amber-100/85">
          {request.reason}
        </div>
      )}
      {request.command && (
        <div className="mt-1 text-[11px] text-zinc-200">
          <span className="text-zinc-400">Command:</span>{" "}
          <span className="font-mono">{request.command}</span>
        </div>
      )}
      {request.cwd && (
        <div className="mt-1 text-[11px] text-zinc-200">
          <span className="text-zinc-400">Cwd:</span>{" "}
          <span className="font-mono">{request.cwd}</span>
        </div>
      )}
      {request.kind === "permissions" && request.permissions && (
        <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-700/45 bg-zinc-950/60 p-2 text-[10px] text-zinc-300">
          {JSON.stringify(request.permissions, null, 2)}
        </pre>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {request.kind === "permissions" ? (
          <>
            <button
              type="button"
              onClick={() =>
                onRespond?.(request, { grant: "allow", scope: "turn" })
              }
              disabled={submitting || !onRespond}
              className="rounded border border-emerald-400/40 bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:cursor-default disabled:opacity-60"
            >
              Allow (turn)
            </button>
            <button
              type="button"
              onClick={() =>
                onRespond?.(request, { grant: "allow", scope: "session" })
              }
              disabled={submitting || !onRespond}
              className="rounded border border-emerald-400/40 bg-emerald-500/15 px-2 py-1 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-500/25 disabled:cursor-default disabled:opacity-60"
            >
              Allow (session)
            </button>
            <button
              type="button"
              onClick={() => onRespond?.(request, { grant: "deny" })}
              disabled={submitting || !onRespond}
              className="rounded border border-red-400/35 bg-red-500/10 px-2 py-1 text-[11px] text-red-100 transition-colors hover:bg-red-500/20 disabled:cursor-default disabled:opacity-60"
            >
              Deny
            </button>
          </>
        ) : (
          request.availableDecisions.map((option) => (
            <button
              type="button"
              key={option.id}
              onClick={() => onRespond?.(request, { decisionId: option.id })}
              disabled={submitting || !onRespond}
              title={option.description}
              className="rounded border border-zinc-500/35 bg-zinc-500/10 px-2 py-1 text-[11px] text-zinc-100 transition-colors hover:bg-zinc-500/20 disabled:cursor-default disabled:opacity-60"
            >
              {option.label}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function ContentBlockRenderer(props: ContentBlockRendererProps) {
  const {
    block,
    blockIndex = null,
    forceExpanded = false,
    toolMap,
    toolInputMap,
    toolTimestampMap,
    fallbackToolMap,
    fallbackToolInputMap,
    fallbackToolTimestampMap,
    onPlanAction,
    aiTerminalContext,
    onFilePathLinkClick,
    pendingUserInputRequestByItemId,
    pendingApprovalRequestByItemId,
    selectedUserInputAnswers,
    resolvedUserInputAnswersByItemId,
    submittingUserInputRequestIds,
    submittingApprovalRequestIds,
    onSelectUserInputOption,
    onChangeUserInputOtherText,
    onSubmitUserInputAnswers,
    onRespondApprovalRequest,
  } = props;
  const [expanded, setExpanded] = useState(() => {
    if (block.type !== "tool_use") {
      return false;
    }

    return shouldDefaultExpandToolUse(block.name);
  });
  const [jsonViewMode, setJsonViewMode] = useState<JsonViewMode>("formatted");

  useEffect(() => {
    if (forceExpanded) {
      setExpanded(true);
    }
  }, [forceExpanded]);

  const wrapSearchableBlock = (contentNode: JSX.Element): JSX.Element => {
    if (blockIndex === null || blockIndex < 0) {
      return contentNode;
    }

    return (
      <div data-search-block-index={String(blockIndex)}>{contentNode}</div>
    );
  };

  if (block.type === "text" && block.text) {
    const sanitized = sanitizeText(block.text);
    if (!sanitized) {
      return null;
    }
    const aiTerminalMessage = parseAiTerminalMessage(sanitized);
    if (aiTerminalMessage) {
      return wrapSearchableBlock(
        <AiTerminalDirectiveRenderer
          directive={aiTerminalMessage.directive}
          leadingMarkdown={aiTerminalMessage.leadingMarkdown}
          trailingMarkdown={aiTerminalMessage.trailingMarkdown}
          aiTerminalContext={aiTerminalContext}
          onFilePathLinkClick={onFilePathLinkClick}
        />,
      );
    }
    const proposedPlan = parseProposedPlanBlock(sanitized);
    if (proposedPlan) {
      return wrapSearchableBlock(
        <ProposedPlanRenderer
          planMarkdown={proposedPlan.planMarkdown}
          trailingMarkdown={proposedPlan.trailingMarkdown}
          onPlanAction={onPlanAction}
          onFilePathLinkClick={onFilePathLinkClick}
        />,
      );
    }
    return wrapSearchableBlock(
      <MarkdownRenderer
        content={sanitized}
        onFilePathLinkClick={onFilePathLinkClick}
      />,
    );
  }

  if (
    block.type === "image" &&
    typeof block.image_url === "string" &&
    block.image_url.trim().length > 0
  ) {
    return wrapSearchableBlock(
      <div className="overflow-hidden rounded-lg border border-zinc-700/45 bg-zinc-950/70">
        <img
          src={block.image_url}
          alt="User image"
          className="max-h-[360px] w-auto max-w-full"
          loading="lazy"
        />
      </div>,
    );
  }

  if (block.type === "thinking" && block.thinking) {
    return wrapSearchableBlock(
      <div className={expanded ? "w-full" : ""}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 text-[11px] text-amber-400/90 transition-colors border border-amber-500/20"
        >
          <Lightbulb size={12} className="opacity-70" />
          <span className="font-medium">thinking</span>
          <span className="text-[10px] opacity-50 ml-0.5">
            {expanded ? "▼" : "▶"}
          </span>
        </button>
        {expanded && (
          <pre className="text-xs text-zinc-400 bg-zinc-900/80 border border-zinc-800 rounded-lg p-3 mt-2 whitespace-pre-wrap max-h-80 overflow-y-auto">
            {block.thinking}
          </pre>
        )}
      </div>,
    );
  }

  if (block.type === "agent_reasoning" && block.text) {
    const reasoningText = formatReasoningText(block.text);
    if (!reasoningText) {
      return null;
    }

    return wrapSearchableBlock(
      <div className={expanded ? "w-full" : "self-start"}>
        <div className="max-w-full overflow-hidden rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/10">
          <div
            className={`${expanded ? "flex" : "inline-flex max-w-full"} items-center gap-1.5 px-2.5 py-1.5`}
          >
            <button
              onClick={() => setExpanded(!expanded)}
              className={`${expanded ? "flex flex-1" : "inline-flex max-w-full"} min-w-0 items-center gap-1.5 text-left text-[11px] text-fuchsia-200/90 transition-colors hover:text-fuchsia-100`}
            >
              <Bot size={12} className="opacity-75" />
              <span className="font-medium">agent step</span>
              {!expanded && (
                <span className="truncate text-fuchsia-100/65">
                  {getReasoningPreview(reasoningText, 140)}
                </span>
              )}
              <span className="ml-0.5 text-[10px] opacity-40">
                {expanded ? "▼" : "▶"}
              </span>
            </button>
          </div>
          {expanded && (
            <div className="border-t border-fuchsia-500/20 bg-fuchsia-500/8 px-3 py-2.5">
              <MarkdownRenderer
                content={reasoningText}
                onFilePathLinkClick={onFilePathLinkClick}
              />
            </div>
          )}
        </div>
      </div>,
    );
  }

  if (block.type === "reasoning" && block.text) {
    const reasoningText = formatReasoningText(block.text);
    if (!reasoningText) {
      return null;
    }

    return wrapSearchableBlock(
      <div className={expanded ? "w-full" : "self-start"}>
        <div className="max-w-full overflow-hidden rounded-lg border border-amber-500/20 bg-amber-500/10">
          <div
            className={`${expanded ? "flex" : "inline-flex max-w-full"} items-center gap-1.5 px-2.5 py-1.5`}
          >
            <button
              onClick={() => setExpanded(!expanded)}
              className={`${expanded ? "flex flex-1" : "inline-flex max-w-full"} min-w-0 items-center gap-1.5 text-left text-[11px] text-amber-300 transition-colors hover:text-amber-200`}
            >
              <Lightbulb size={12} className="opacity-70" />
              <span className="font-medium">reasoning</span>
              {!expanded && (
                <span className="truncate text-amber-100/65">
                  {getReasoningPreview(reasoningText, 140)}
                </span>
              )}
              <span className="ml-0.5 text-[10px] opacity-40">
                {expanded ? "▼" : "▶"}
              </span>
            </button>
          </div>
          {expanded && (
            <div className="border-t border-amber-500/20 bg-amber-500/8 px-3 py-2.5">
              <MarkdownRenderer
                content={reasoningText}
                onFilePathLinkClick={onFilePathLinkClick}
              />
            </div>
          )}
        </div>
      </div>,
    );
  }

  if (block.type === "tool_use") {
    const input =
      block.input && typeof block.input === "object"
        ? (block.input as Record<string, unknown>)
        : undefined;
    const hasInput = !!input && Object.keys(input).length > 0;
    const Icon = getToolIcon(block.name || "");
    const preview = getToolPreview(block.name || "", input);
    const toolName = block.name?.toLowerCase() || "";
    const requestUserInputRequest =
      toolName === "request_user_input" && block.id
        ? pendingUserInputRequestByItemId?.get(block.id)
        : undefined;
    const resolvedAnswersForRequest =
      toolName === "request_user_input" && block.id
        ? resolvedUserInputAnswersByItemId?.get(block.id)
        : undefined;
    const interactiveUserInputRequest = resolvedAnswersForRequest
      ? undefined
      : requestUserInputRequest;
    const selectedAnswersForRequest =
      resolvedAnswersForRequest ||
      (interactiveUserInputRequest
        ? selectedUserInputAnswers?.[interactiveUserInputRequest.requestId]
        : undefined);
    const submittingUserInputRequest = interactiveUserInputRequest
      ? submittingUserInputRequestIds?.has(
          interactiveUserInputRequest.requestId,
        ) === true
      : false;
    const approvalRequest = block.id
      ? pendingApprovalRequestByItemId?.get(block.id)
      : undefined;
    const submittingApprovalRequest = approvalRequest
      ? submittingApprovalRequestIds?.has(approvalRequest.requestId) === true
      : false;

    const isExpanded = expanded;
    const hasDetails = hasInput || !!approvalRequest;
    const canToggleExpanded = hasDetails;
    const supportsRawToggle = hasInput;
    const expandedLabel = getToolExpandedLabel(toolName);
    const copyText = isExpanded ? getToolCopyText(toolName, input) : null;

    return wrapSearchableBlock(
      <div className={isExpanded ? "w-full" : "self-start max-w-full"}>
        <div className="max-w-full overflow-hidden rounded-lg border border-slate-500/20 bg-slate-500/10">
          <div
            className={`${isExpanded ? "flex" : "inline-flex max-w-full"} items-center gap-1.5 px-2.5 py-1.5`}
          >
            <button
              type="button"
              onClick={() => canToggleExpanded && setExpanded(!expanded)}
              className={`${isExpanded ? "flex flex-1" : "inline-flex max-w-full"} min-w-0 items-center gap-1.5 text-left text-[11px] transition-colors ${
                canToggleExpanded
                  ? "cursor-pointer text-slate-200 hover:text-slate-100"
                  : "cursor-default text-slate-200"
              }`}
            >
              <Icon size={12} className="opacity-60" />
              <span className="font-medium">{block.name}</span>
              {expandedLabel && isExpanded && (
                <span className="font-normal text-slate-400">
                  {expandedLabel}
                </span>
              )}
              {preview && !isExpanded && (
                <span className="min-w-0 max-w-full truncate font-normal text-slate-400">
                  {preview}
                </span>
              )}
              {canToggleExpanded && (
                <span className="ml-0.5 text-[10px] opacity-40">
                  {expanded ? "▼" : "▶"}
                </span>
              )}
            </button>
            {copyText && (
              <CopyButton
                text={copyText}
                title="Copy command"
                className="rounded-lg border border-slate-500/20 bg-slate-500/10 hover:bg-slate-500/15"
              />
            )}
            {supportsRawToggle && isExpanded && (
              <button
                type="button"
                onClick={() =>
                  setJsonViewMode((current) =>
                    current === "formatted" ? "raw" : "formatted",
                  )
                }
                className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                  jsonViewMode === "raw"
                    ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                    : "border-slate-500/20 bg-slate-500/10 text-slate-300 hover:bg-slate-500/15"
                }`}
                title={
                  jsonViewMode === "raw"
                    ? "Show formatted view"
                    : "Show raw JSON"
                }
              >
                {"</>"}
              </button>
            )}
          </div>
          {isExpanded && hasDetails && (
            <div className="border-t border-slate-500/20 px-2.5 py-2">
              {hasInput && input && (
                <div>
                  {renderToolInput(
                    block,
                    input,
                    jsonViewMode,
                    true,
                    onFilePathLinkClick,
                    interactiveUserInputRequest,
                    selectedAnswersForRequest,
                    submittingUserInputRequest,
                    onSelectUserInputOption,
                    onChangeUserInputOtherText,
                    onSubmitUserInputAnswers,
                  )}
                </div>
              )}
              {approvalRequest && (
                <ApprovalRequestRenderer
                  request={approvalRequest}
                  submitting={submittingApprovalRequest}
                  onRespond={onRespondApprovalRequest}
                />
              )}
            </div>
          )}
        </div>
      </div>,
    );
  }

  if (block.type === "tool_result") {
    const isError = block.is_error;
    const rawContent =
      typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content, null, 2);
    const resultContent = sanitizeText(rawContent);
    const hasContent = resultContent.length > 0;
    const previewLength = 120;
    const toolName =
      block.name ||
      (block.tool_use_id
        ? toolMap?.get(block.tool_use_id) ||
          fallbackToolMap?.get(block.tool_use_id) ||
          ""
        : "");
    const toolInput = block.tool_use_id
      ? toolInputMap?.get(block.tool_use_id) ||
        fallbackToolInputMap?.get(block.tool_use_id)
      : undefined;
    const command = getCommandFromToolInput(toolInput);

    const contentPreview =
      hasContent && !expanded
        ? withMultilineCollapsedIndicator(
            getToolResultPreview(toolName, resultContent) ||
              resultContent.slice(0, previewLength) +
                (resultContent.length > previewLength ? "..." : ""),
            resultContent,
          )
        : null;
    const rawJsonValue = getToolResultRawValue(block, toolName);
    const supportsRawToggle = rawJsonValue !== null;
    const canToggleExpanded = hasContent;
    const normalizedToolName = toolName.toLowerCase();
    const isCommandResult =
      normalizedToolName === "exec_command" ||
      normalizedToolName === "write_stdin" ||
      normalizedToolName === "bash";
    const commandStartedAt = block.tool_use_id
      ? toolTimestampMap?.get(block.tool_use_id) ||
        fallbackToolTimestampMap?.get(block.tool_use_id)
      : undefined;
    const commandDuration = isCommandResult
      ? formatDurationFromTimestamps(commandStartedAt, block.timestamp)
      : null;
    const expandedLabel =
      expanded && isCommandResult ? "Terminal output" : null;
    const resultCopyText =
      expanded && isCommandResult && hasContent
        ? getExecBody(resultContent)
        : null;

    return wrapSearchableBlock(
      <div className={expanded ? "w-full" : "self-start max-w-full"}>
        <div
          className={`max-w-full overflow-hidden rounded-lg border ${
            isError
              ? "border-rose-500/20 bg-rose-500/10"
              : "border-teal-500/20 bg-teal-500/10"
          }`}
        >
          <div
            className={`${expanded ? "flex" : "inline-flex max-w-full"} items-center gap-1.5 px-2.5 py-1.5`}
          >
            <button
              type="button"
              onClick={() => canToggleExpanded && setExpanded(!expanded)}
              className={`${expanded ? "flex flex-1" : "inline-flex max-w-full"} min-w-0 items-center gap-1.5 text-left text-[11px] transition-colors ${
                canToggleExpanded
                  ? isError
                    ? "cursor-pointer text-rose-300 hover:text-rose-200"
                    : "cursor-pointer text-teal-200 hover:text-teal-100"
                  : isError
                    ? "cursor-default text-rose-300"
                    : "cursor-default text-teal-200"
              }`}
            >
              {isError ? (
                <X size={12} className="opacity-70" />
              ) : (
                <Check size={12} className="opacity-70" />
              )}
              <span className="font-medium">
                {isError ? "error" : "result"}
              </span>
              {expandedLabel && (
                <span
                  className={`font-normal ${isError ? "text-rose-400/75" : "text-teal-400/75"}`}
                >
                  {expandedLabel}
                </span>
              )}
              {commandDuration && (
                <span
                  className={`inline-flex items-center gap-1 font-normal ${isError ? "text-rose-400/75" : "text-teal-400/75"}`}
                >
                  <Clock3 size={11} className="shrink-0 opacity-80" />
                  <span>{commandDuration}</span>
                </span>
              )}
              {contentPreview && !expanded && (
                <span
                  className={`min-w-0 max-w-full truncate font-normal ${isError ? "text-rose-400/70" : "text-teal-400/70"}`}
                >
                  {contentPreview}
                </span>
              )}
              {canToggleExpanded && (
                <span className="ml-0.5 text-[10px] opacity-40">
                  {expanded ? "▼" : "▶"}
                </span>
              )}
            </button>
            {resultCopyText && (
              <CopyButton
                text={resultCopyText}
                title="Copy output"
                className={`rounded-lg border ${
                  isError
                    ? "border-rose-500/25 bg-rose-500/10 hover:bg-rose-500/15"
                    : "border-teal-500/25 bg-teal-500/10 hover:bg-teal-500/15"
                }`}
              />
            )}
            {supportsRawToggle && expanded && (
              <button
                type="button"
                onClick={() =>
                  setJsonViewMode((current) =>
                    current === "formatted" ? "raw" : "formatted",
                  )
                }
                className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                  jsonViewMode === "raw"
                    ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                    : isError
                      ? "border-rose-500/25 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15"
                      : "border-teal-500/25 bg-teal-500/10 text-teal-200 hover:bg-teal-500/15"
                }`}
                title={
                  jsonViewMode === "raw"
                    ? "Show formatted view"
                    : "Show raw JSON"
                }
              >
                {"</>"}
              </button>
            )}
          </div>
          {expanded && hasContent && (
            <div
              className={`border-t px-2.5 py-2 ${
                isError ? "border-rose-500/20" : "border-teal-500/20"
              }`}
            >
              {supportsRawToggle && jsonViewMode === "raw" ? (
                <JsonRenderer value={rawJsonValue} />
              ) : (
                <ToolResultRenderer
                  toolName={toolName}
                  content={resultContent}
                  isError={isError}
                  command={command}
                  embedded
                  hideHeader={isCommandResult}
                  onFilePathLinkClick={onFilePathLinkClick}
                />
              )}
            </div>
          )}
        </div>
      </div>,
    );
  }

  return null;
}

export default MessageBlock;
