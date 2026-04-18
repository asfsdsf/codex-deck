import type {
  ConversationMessage,
  SystemContextResponse,
} from "@codex-deck/api";
import { sanitizeTerminalTranscriptChunk } from "../api/terminal-transcript";

export const AI_TERMINAL_DEVELOPER_INSTRUCTIONS = `You are an AI terminal planning assistant.

Your job is to translate the user's request and the controller's execution summaries into one actionable shell plan at a time.

Rules:
- Output normal markdown plus exactly one machine-readable action block when you need the controller to react.
- Never assume a fixed OS. Use the provided current OS release, architecture, shell, terminal id, and cwd.
- Commands must be non-interactive and safe to present for explicit approval.
- Prefer the provided current cwd unless the user clearly asked to work elsewhere.
- A reply may include multiple commands only as ordered steps inside one <ai-terminal-plan>.
- Each <ai-terminal-step> must contain exactly one shell command.
- Keep explanations short because another process will parse the block.
- If a step fails, briefly explain the likely cause and propose a revised next plan.
- When the task is complete, emit <requirement_finished>...</requirement_finished> and no plan block.

Action block contract:
<ai-terminal-plan>
  <context_note>optional shared note</context_note>
  <ai-terminal-step>
    <step_id>stable short id</step_id>
    <step_goal>short goal</step_goal>
    <command><![CDATA[exactly one shell command]]></command>
    <cwd>execution directory</cwd>
    <shell>shell name</shell>
    <risk>low|medium|high</risk>
    <next_action>approve|reject|provide_input</next_action>
    <explanation>brief explanation of key flags or terms</explanation>
    <context_note>optional step note</context_note>
  </ai-terminal-step>
</ai-terminal-plan>

Need-input block:
<ai-terminal-need-input>
  <question>short question for the user</question>
  <context_note>optional note</context_note>
</ai-terminal-need-input>

Completion:
<requirement_finished>further suggestions or precautions</requirement_finished>`;

const AI_TERMINAL_PLAN_BLOCK_PATTERN =
  /<ai-terminal-plan>\s*[\s\S]*?<\/ai-terminal-plan>|<ai-terminal-need-input>\s*[\s\S]*?<\/ai-terminal-need-input>|<requirement_finished>\s*[\s\S]*?<\/requirement_finished>/gi;
const AI_TERMINAL_STEP_PATTERN =
  /<ai-terminal-step>\s*([\s\S]*?)\s*<\/ai-terminal-step>/gi;

export type AiTerminalRisk = "low" | "medium" | "high";
export type AiTerminalNextAction = "approve" | "reject" | "provide_input";
export type AiTerminalStepState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "rejected";

export interface AiTerminalEnvironment {
  osName: string;
  osRelease: string;
  osVersion: string | null;
  architecture: string;
  platform: string;
  hostname: string;
  shell: string;
  cwd: string;
}

export interface AiTerminalStepDirective {
  stepId: string;
  stepGoal: string | null;
  command: string;
  explanation: string | null;
  cwd: string | null;
  shell: string | null;
  risk: AiTerminalRisk;
  nextAction: AiTerminalNextAction;
  contextNote: string | null;
}

export interface AiTerminalPlanDirective {
  kind: "plan";
  contextNote: string | null;
  steps: AiTerminalStepDirective[];
}

export interface AiTerminalNeedInputDirective {
  kind: "need_input";
  question: string;
  contextNote: string | null;
}

export interface AiTerminalFinishedDirective {
  kind: "finished";
  message: string;
}

export type AiTerminalDirective =
  | AiTerminalPlanDirective
  | AiTerminalNeedInputDirective
  | AiTerminalFinishedDirective;

export interface AiTerminalRenderedMessage {
  leadingMarkdown: string;
  directive: AiTerminalDirective;
  trailingMarkdown: string;
  rawBlock: string;
}

export interface AiTerminalHistoryEntry {
  stepId: string;
  goal: string;
  command: string;
  state: "approved" | "rejected" | "completed" | "failed";
  summary: string | null;
}

export interface AiTerminalExecutionResult {
  stepId: string;
  exitCode: number | null;
  timedOut: boolean;
  cwdAfter: string;
  outputSummary: string;
  errorSummary: string | null;
  rawOutput: string;
  markerFound: boolean;
}

export type AiTerminalExecutionStatus =
  | "success"
  | "failed"
  | "timed_out"
  | "completed_unknown";

export interface AiTerminalExecutionFeedback {
  kind: "execution";
  stepId: string;
  status: AiTerminalExecutionStatus;
  exitCode: number | null;
  cwdAfter: string | null;
  outputSummary: string | null;
  errorSummary: string | null;
  outputReference: string | null;
}

export interface AiTerminalRejectionFeedback {
  kind: "rejection";
  stepId: string;
  decision: "rejected";
  reason: string | null;
}

export type AiTerminalUserFeedback =
  | AiTerminalExecutionFeedback
  | AiTerminalRejectionFeedback;

export interface AiTerminalBootstrapMessage {
  kind: "bootstrap";
  terminalId: string;
  cwd: string | null;
  shell: string | null;
  osName: string | null;
  osRelease: string | null;
  architecture: string | null;
  platform: string | null;
  userRequest: string | null;
}

interface AiTerminalPersistedStepState {
  stepId: string;
  state: AiTerminalStepState;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function buildApprovedAiTerminalInput(
  step: Pick<AiTerminalStepDirective, "command">,
): string {
  return step.command.endsWith("\n") ? step.command : `${step.command}\n`;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractTagValue(text: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i");
  const match = text.match(pattern);
  if (!match) {
    return null;
  }

  const rawValue = match[1] ?? "";
  if (/^(?:\s*<!\[CDATA\[[\s\S]*?\]\]>\s*)+$/.test(rawValue)) {
    const cdataSegments = Array.from(
      rawValue.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g),
      (segment) => segment[1] ?? "",
    );
    return normalizeText(cdataSegments.join(""));
  }

  return normalizeText(decodeXmlText(rawValue));
}

function wrapCdata(value: string): string {
  return `<![CDATA[${value.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

function pickRisk(value: string | null): AiTerminalRisk {
  if (value === "high" || value === "medium") {
    return value;
  }
  return "low";
}

function pickNextAction(value: string | null): AiTerminalNextAction | null {
  if (value === "approve" || value === "reject" || value === "provide_input") {
    return value;
  }
  return null;
}

function pickExecutionStatus(
  value: string | null,
): AiTerminalExecutionStatus | null {
  if (
    value === "success" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "completed_unknown"
  ) {
    return value;
  }
  return null;
}

function parseOptionalInteger(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAiTerminalStep(text: string): AiTerminalStepDirective | null {
  const stepId = extractTagValue(text, "step_id");
  const command = extractTagValue(text, "command");
  const nextAction = pickNextAction(extractTagValue(text, "next_action"));
  if (!stepId || !command || !nextAction) {
    return null;
  }

  return {
    stepId,
    stepGoal: extractTagValue(text, "step_goal"),
    command,
    explanation: extractTagValue(text, "explanation"),
    cwd: extractTagValue(text, "cwd"),
    shell: extractTagValue(text, "shell"),
    risk: pickRisk(extractTagValue(text, "risk")),
    nextAction,
    contextNote: extractTagValue(text, "context_note"),
  };
}

function parseAiTerminalDirective(
  rawBlock: string,
): AiTerminalDirective | null {
  const normalized = rawBlock.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("<requirement_finished>")) {
    const message = extractTagValue(normalized, "requirement_finished");
    return message
      ? {
          kind: "finished",
          message,
        }
      : null;
  }

  if (normalized.startsWith("<ai-terminal-need-input>")) {
    const question = extractTagValue(normalized, "question");
    if (!question) {
      return null;
    }
    return {
      kind: "need_input",
      question,
      contextNote: extractTagValue(normalized, "context_note"),
    };
  }

  if (!normalized.startsWith("<ai-terminal-plan>")) {
    return null;
  }

  const inner = normalized
    .replace(/^<ai-terminal-plan>\s*/i, "")
    .replace(/\s*<\/ai-terminal-plan>$/i, "");
  const steps: AiTerminalStepDirective[] = [];
  let stepMatch: RegExpExecArray | null;
  while ((stepMatch = AI_TERMINAL_STEP_PATTERN.exec(inner)) !== null) {
    const parsed = parseAiTerminalStep(stepMatch[1] ?? "");
    if (!parsed) {
      return null;
    }
    steps.push(parsed);
  }
  AI_TERMINAL_STEP_PATTERN.lastIndex = 0;
  if (steps.length === 0) {
    return null;
  }

  return {
    kind: "plan",
    contextNote: extractTagValue(inner, "context_note"),
    steps,
  };
}

export function parseAiTerminalMessage(
  text: string,
): AiTerminalRenderedMessage | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  const matches = Array.from(
    normalized.matchAll(AI_TERMINAL_PLAN_BLOCK_PATTERN),
  );
  if (matches.length !== 1) {
    return null;
  }

  const match = matches[0];
  const rawBlock = match?.[0]?.trim() ?? "";
  const directive = parseAiTerminalDirective(rawBlock);
  if (!directive) {
    return null;
  }

  const startIndex = match.index ?? 0;
  const leadingMarkdown = normalized.slice(0, startIndex).trim();
  const trailingMarkdown = normalized
    .slice(startIndex + rawBlock.length)
    .trim();

  return {
    leadingMarkdown,
    directive,
    trailingMarkdown,
    rawBlock,
  };
}

export function parseAiTerminalPersistedStepState(
  text: string,
): AiTerminalPersistedStepState | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  const executionBlock = normalized.match(
    /<ai-terminal-execution>\s*([\s\S]*?)\s*<\/ai-terminal-execution>/i,
  );
  if (executionBlock) {
    const block = executionBlock[1] ?? "";
    const stepId = extractTagValue(block, "step_id");
    const status = extractTagValue(block, "status");
    if (!stepId || !status) {
      return null;
    }
    if (status === "failed" || status === "timed_out") {
      return {
        stepId,
        state: "failed",
      };
    }
    if (status === "success" || status === "completed_unknown") {
      return {
        stepId,
        state: "completed",
      };
    }
    return null;
  }

  const feedbackBlock = normalized.match(
    /<ai-terminal-feedback>\s*([\s\S]*?)\s*<\/ai-terminal-feedback>/i,
  );
  if (!feedbackBlock) {
    return null;
  }

  const block = feedbackBlock[1] ?? "";
  const stepId = extractTagValue(block, "step_id");
  const decision = extractTagValue(block, "decision");
  if (!stepId || decision !== "rejected") {
    return null;
  }

  return {
    stepId,
    state: "rejected",
  };
}

export function parseAiTerminalUserFeedback(
  text: string,
): AiTerminalUserFeedback | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }

  const executionBlock = normalized.match(
    /^<ai-terminal-execution>\s*([\s\S]*?)\s*<\/ai-terminal-execution>$/i,
  );
  if (executionBlock) {
    const block = executionBlock[1] ?? "";
    const stepId = extractTagValue(block, "step_id");
    const status = pickExecutionStatus(extractTagValue(block, "status"));
    if (!stepId || !status) {
      return null;
    }

    return {
      kind: "execution",
      stepId,
      status,
      exitCode: parseOptionalInteger(extractTagValue(block, "exit_code")),
      cwdAfter: extractTagValue(block, "cwd_after"),
      outputSummary: extractTagValue(block, "output_summary"),
      errorSummary: extractTagValue(block, "error_summary"),
      outputReference: extractTagValue(block, "output_reference"),
    };
  }

  const feedbackBlock = normalized.match(
    /^<ai-terminal-feedback>\s*([\s\S]*?)\s*<\/ai-terminal-feedback>$/i,
  );
  if (!feedbackBlock) {
    return null;
  }

  const block = feedbackBlock[1] ?? "";
  const stepId = extractTagValue(block, "step_id");
  const decision = extractTagValue(block, "decision");
  if (!stepId || decision !== "rejected") {
    return null;
  }

  return {
    kind: "rejection",
    stepId,
    decision: "rejected",
    reason: extractTagValue(block, "reason"),
  };
}

export function parseAiTerminalBootstrapMessage(
  text: string,
): AiTerminalBootstrapMessage | null {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized || !normalized.includes("<ai-terminal-controller-context>")) {
    return null;
  }

  const contextMatch = normalized.match(
    /<ai-terminal-controller-context>\s*([\s\S]*?)\s*<\/ai-terminal-controller-context>/i,
  );
  if (!contextMatch) {
    return null;
  }

  const contextBlock = contextMatch[1] ?? "";
  const terminalId = extractTagValue(contextBlock, "terminal_id");
  if (!terminalId) {
    return null;
  }

  return {
    kind: "bootstrap",
    terminalId,
    cwd: extractTagValue(contextBlock, "cwd"),
    shell: extractTagValue(contextBlock, "shell"),
    osName: extractTagValue(contextBlock, "os_name"),
    osRelease: extractTagValue(contextBlock, "os_release"),
    architecture: extractTagValue(contextBlock, "architecture"),
    platform: extractTagValue(contextBlock, "platform"),
    userRequest: extractTagValue(normalized, "user-request"),
  };
}

export function deriveAiTerminalStepStatesByMessageKey<T>(
  items: T[],
  input: {
    getMessage: (item: T) => ConversationMessage | null | undefined;
    getMessageKey: (
      item: T,
      index: number,
      planIndex: number,
    ) => string | null | undefined;
  },
): Record<string, Record<string, AiTerminalStepState | undefined>> {
  const stepStatesByMessageKey: Record<
    string,
    Record<string, AiTerminalStepState | undefined>
  > = {};
  const plans: Array<{ messageKey: string; stepIds: Set<string> }> = [];
  let planIndex = 0;

  items.forEach((item, index) => {
    const message = input.getMessage(item);
    if (!message) {
      return;
    }

    const text = extractConversationMessageText(message);
    if (!text) {
      return;
    }

    const parsedPlan = parseAiTerminalMessage(text);
    if (message.type === "assistant" && parsedPlan?.directive.kind === "plan") {
      const messageKey = input.getMessageKey(item, index, planIndex)?.trim();
      planIndex += 1;
      if (!messageKey) {
        return;
      }

      plans.push({
        messageKey,
        stepIds: new Set(parsedPlan.directive.steps.map((step) => step.stepId)),
      });
      return;
    }

    const persistedState = parseAiTerminalPersistedStepState(text);
    if (!persistedState) {
      return;
    }

    for (
      let currentPlanIndex = plans.length - 1;
      currentPlanIndex >= 0;
      currentPlanIndex -= 1
    ) {
      const plan = plans[currentPlanIndex];
      if (!plan?.stepIds.has(persistedState.stepId)) {
        continue;
      }

      stepStatesByMessageKey[plan.messageKey] = {
        ...(stepStatesByMessageKey[plan.messageKey] ?? {}),
        [persistedState.stepId]: persistedState.state,
      };
      break;
    }
  });

  return stepStatesByMessageKey;
}

export function mergeAiTerminalStepStates(
  persistedStates?: Record<string, AiTerminalStepState | undefined> | null,
  overlayStates?: Record<string, AiTerminalStepState | undefined> | null,
): Record<string, AiTerminalStepState | undefined> | undefined {
  const normalizedPersisted = persistedStates ?? undefined;
  const normalizedOverlay = overlayStates ?? undefined;
  if (!normalizedPersisted && !normalizedOverlay) {
    return undefined;
  }
  return {
    ...(normalizedOverlay ?? {}),
    ...(normalizedPersisted ?? {}),
  };
}

export function hasAiTerminalDirective(text: string): boolean {
  return parseAiTerminalMessage(text) !== null;
}

function stripTerminalPromptNoise(output: string): string {
  const lines = output.split(/\r?\n/u);

  while (lines.length > 0) {
    const trimmed = (lines[lines.length - 1] ?? "").trim();
    if (!trimmed) {
      lines.pop();
      continue;
    }
    if (/^[%=><]$/.test(trimmed)) {
      lines.pop();
      continue;
    }
    if (
      /[#$%>»]$/.test(trimmed) &&
      (trimmed.includes("/") ||
        trimmed.includes("~") ||
        trimmed.startsWith("(") ||
        trimmed.startsWith("["))
    ) {
      lines.pop();
      continue;
    }
    break;
  }

  return lines.join("\n").trim();
}

function summarizeLines(lines: string[], limit: number): string[] {
  if (lines.length <= limit * 2) {
    return lines;
  }
  return [
    ...lines.slice(0, limit),
    `... ${lines.length - limit * 2} more lines omitted ...`,
    ...lines.slice(-limit),
  ];
}

export function summarizeAiTerminalOutput(output: string): {
  outputSummary: string;
  errorSummary: string | null;
} {
  const normalized = stripTerminalPromptNoise(
    sanitizeTerminalTranscriptChunk(output),
  );
  if (!normalized) {
    return {
      outputSummary: "Command produced no visible output.",
      errorSummary: null,
    };
  }

  const lines = normalized
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const summarizedLines = summarizeLines(lines, 8);
  const errorLines = lines.filter((line) =>
    /\b(error|failed|not found|permission denied|timed out|exception)\b/i.test(
      line,
    ),
  );

  return {
    outputSummary: summarizedLines.join("\n").trim(),
    errorSummary:
      errorLines.length > 0 ? errorLines.slice(0, 6).join("\n") : null,
  };
}

export function extractConversationMessageText(
  message: ConversationMessage | null | undefined,
): string {
  const content = message?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((block) => {
      if (block?.type === "text" && typeof block.text === "string") {
        return [block.text.trim()];
      }
      return [];
    })
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

export function getAiTerminalMessageKey(
  message: ConversationMessage | null | undefined,
): string | null {
  if (!message) {
    return null;
  }
  const uuid = normalizeText(message.uuid);
  const turnId = normalizeText(message.turnId);
  const timestamp = normalizeText(message.timestamp);
  const syntheticChunkScopedUuid =
    uuid !== null && /^\d+:message:\d+$/u.test(uuid);
  if ((turnId || timestamp) && (syntheticChunkScopedUuid || !uuid)) {
    return `${message.type}:${turnId ?? ""}:${timestamp ?? ""}`;
  }
  if (uuid) {
    return uuid;
  }
  if (!turnId && !timestamp) {
    return null;
  }
  return `${message.type}:${turnId ?? ""}:${timestamp ?? ""}`;
}

export function findLatestAssistantResponse(
  messages: ConversationMessage[],
  turnId: string | null,
): { message: ConversationMessage; text: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.type !== "assistant") {
      continue;
    }
    if (turnId && (message.turnId ?? null) !== turnId) {
      continue;
    }
    const text = extractConversationMessageText(message);
    if (text) {
      return { message, text };
    }
  }
  return null;
}

export function buildAiTerminalEnvironment(input: {
  system: SystemContextResponse;
  cwd: string;
  shell: string | null | undefined;
}): AiTerminalEnvironment {
  return {
    osName: input.system.osName,
    osRelease: input.system.osRelease,
    osVersion: input.system.osVersion,
    architecture: input.system.architecture,
    platform: input.system.platform,
    hostname: input.system.hostname,
    shell:
      normalizeText(input.shell) ||
      normalizeText(input.system.defaultShell) ||
      "sh",
    cwd: input.cwd.trim(),
  };
}

function formatHistory(history: AiTerminalHistoryEntry[]): string {
  if (history.length === 0) {
    return "None.";
  }

  return history
    .slice(-6)
    .map(
      (entry) =>
        `- ${entry.stepId} | ${entry.state} | goal=${entry.goal} | command=${entry.command}${
          entry.summary ? ` | summary=${entry.summary}` : ""
        }`,
    )
    .join("\n");
}

export function buildAiTerminalExecutionFeedback(input: {
  result: AiTerminalExecutionResult;
  outputReference?: string | null;
}): string {
  const status = input.result.timedOut
    ? "timed_out"
    : input.result.exitCode === 0
      ? "success"
      : input.result.exitCode === null
        ? "completed_unknown"
        : "failed";

  const parts = [
    "<ai-terminal-execution>",
    `<step_id>${input.result.stepId}</step_id>`,
    `<status>${status}</status>`,
    `<exit_code>${
      input.result.exitCode === null ? "" : String(input.result.exitCode)
    }</exit_code>`,
    `<cwd_after>${input.result.cwdAfter}</cwd_after>`,
    `<output_summary><![CDATA[${input.result.outputSummary}]]></output_summary>`,
  ];
  if (input.result.errorSummary) {
    parts.push(
      `<error_summary><![CDATA[${input.result.errorSummary}]]></error_summary>`,
    );
  }
  const outputReference = normalizeText(input.outputReference);
  if (outputReference) {
    parts.push(`<output_reference>${outputReference}</output_reference>`);
  }
  parts.push("</ai-terminal-execution>");
  return parts.join("\n");
}

export function buildAiTerminalRejectionFeedback(input: {
  stepId: string;
  reason?: string | null;
}): string {
  const parts = [
    "<ai-terminal-feedback>",
    `<step_id>${input.stepId}</step_id>`,
    "<decision>rejected</decision>",
  ];
  const reason = normalizeText(input.reason);
  if (reason) {
    parts.push(`<reason>${wrapCdata(reason)}</reason>`);
  }
  parts.push("</ai-terminal-feedback>");
  return parts.join("\n");
}

export function shouldAttachAiTerminalOutputReference(
  rawOutput: string,
): boolean {
  const normalized = rawOutput.trim();
  if (!normalized) {
    return false;
  }
  const lineCount = normalized.split(/\r?\n/u).length;
  return normalized.length > 1200 || lineCount > 16;
}

export function buildAiTerminalTurnPrompt(input: {
  environment: AiTerminalEnvironment;
  userRequest: string | null;
  userFollowup: string | null;
  latestExecution: AiTerminalExecutionResult | null;
  history: AiTerminalHistoryEntry[];
  currentStep: AiTerminalStepDirective | null;
}): string {
  const environment = input.environment;
  const sections = [
    "<ai_terminal_context>",
    `<os_name>${environment.osName}</os_name>`,
    `<os_release>${environment.osRelease}</os_release>`,
    `<os_version>${environment.osVersion ?? ""}</os_version>`,
    `<architecture>${environment.architecture}</architecture>`,
    `<platform>${environment.platform}</platform>`,
    `<hostname>${environment.hostname}</hostname>`,
    `<shell>${environment.shell}</shell>`,
    `<cwd>${environment.cwd}</cwd>`,
    "</ai_terminal_context>",
    "<task_history>",
    formatHistory(input.history),
    "</task_history>",
  ];

  if (input.currentStep?.stepId) {
    sections.push("<current_step>");
    sections.push(`<step_id>${input.currentStep.stepId}</step_id>`);
    sections.push(`<step_goal>${input.currentStep.stepGoal ?? ""}</step_goal>`);
    sections.push(
      `<command><![CDATA[${input.currentStep.command}]]></command>`,
    );
    sections.push("</current_step>");
  }

  if (input.latestExecution) {
    sections.push(
      buildAiTerminalExecutionFeedback({ result: input.latestExecution }),
    );
  }

  if (normalizeText(input.userRequest)) {
    sections.push("<user_request>");
    sections.push(input.userRequest!.trim());
    sections.push("</user_request>");
  }

  if (normalizeText(input.userFollowup)) {
    sections.push("<user_followup>");
    sections.push(input.userFollowup!.trim());
    sections.push("</user_followup>");
  }

  sections.push(
    "Respond with markdown plus exactly one actionable terminal tag block.",
  );

  return sections.join("\n");
}
