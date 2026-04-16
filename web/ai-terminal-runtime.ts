import {
  getTerminalSnapshot,
  runInTerminal,
  type RunInTerminalResult,
} from "./api";
import {
  AI_TERMINAL_RESULT_MARKER_OSC_PREFIX,
  buildAiTerminalExecutionWrapper,
  parseAiTerminalExecutionResult,
  summarizeAiTerminalOutput,
  type AiTerminalExecutionResult,
  type AiTerminalStepDirective,
} from "./ai-terminal";
import { sanitizeTerminalTranscriptChunk } from "./terminal-timeline";

export type AiTerminalExecutionDisplayState =
  | "running"
  | "completed"
  | "failed";

export interface AiTerminalStepExecution {
  terminalId: string;
  stepId: string;
  command: string;
  cwd: string;
  status: AiTerminalExecutionDisplayState;
  startSeq: number;
  startOffset: number;
  startedAt: number;
  completedAt: number | null;
  frozenOutput: string | null;
}

const APPROVED_AI_TERMINAL_TIMEOUT_MS = 30 * 60 * 1000;

interface RunApprovedAiTerminalStepDeps {
  getTerminalSnapshot: typeof getTerminalSnapshot;
  runInTerminal: typeof runInTerminal;
  now: () => number;
}

interface RunApprovedAiTerminalStepInput {
  terminalId: string;
  step: AiTerminalStepDirective;
  onStart?: (execution: AiTerminalStepExecution) => void;
}

interface RunApprovedAiTerminalStepResult {
  execution: AiTerminalStepExecution;
  result: AiTerminalExecutionResult;
  runResult: RunInTerminalResult;
}

const DEFAULT_DEPS: RunApprovedAiTerminalStepDeps = {
  getTerminalSnapshot,
  runInTerminal,
  now: () => Date.now(),
};

function stripLikelyPromptPrefix(line: string): string {
  const trimmed = line.trim();
  const withoutContinuationPrompt = trimmed.replace(
    /^.*?\bcursh>\s*=?\s*/iu,
    "",
  );
  const withoutPrompt =
    withoutContinuationPrompt !== trimmed
      ? withoutContinuationPrompt
      : trimmed.replace(
          /^(?:\([^)]*\)\s*)?[^\r\n]{0,80}?\s[»>$#%]\s*=?\s*/u,
          "",
        );

  return withoutPrompt.replace(/^=\s*/u, "").replace(/>$/u, "").trim();
}

function normalizeShellLineForComparison(line: string): string {
  return stripLikelyPromptPrefix(line)
    .replace(/\s+#\s+__CODEX_DECK_AI_STEP_ID=[A-Za-z0-9._:-]+\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function shouldDropWrapperLine(line: string, command: string): boolean {
  const rawTrimmed = line.trim();
  const normalized = normalizeShellLineForComparison(line);
  const normalizedCommand = command.replace(/\s+/gu, " ").trim();

  if (/^[{}][>»]?\s*$/u.test(rawTrimmed)) {
    return true;
  }
  if (rawTrimmed.includes("__CODEX_DECK_AI_STEP_ID=")) {
    return true;
  }
  if (!normalized) {
    return false;
  }
  if (normalized === "{" || normalized === "}") {
    return true;
  }
  if (normalized === normalizedCommand) {
    return true;
  }
  if (
    normalized.endsWith(normalizedCommand) &&
    /^cd\s+.+\s+&&\s+/u.test(normalized)
  ) {
    return true;
  }
  if (/^cd\s+.+\s+\|\|\s+exit\s+1$/u.test(normalized)) {
    return true;
  }
  if (/^__CODEX_DECK_AI_(?:EXIT_CODE|CWD)=/u.test(normalized)) {
    return true;
  }
  if (normalized.includes("__CODEX_DECK_AI_RESULT__")) {
    return true;
  }
  if (/^printf\s+['"]?\\n__CODEX_DECK_AI_RESULT__/u.test(normalized)) {
    return true;
  }

  return false;
}

export function cleanAiTerminalExecutionOutput(
  rawOutput: string,
  command: string,
): string {
  const sanitized = sanitizeTerminalTranscriptChunk(rawOutput);
  const lines = sanitized.split("\n");
  const keptLines = lines.filter(
    (line) => !shouldDropWrapperLine(line, command),
  );
  return keptLines
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd();
}

function getFallbackCwd(
  step: AiTerminalStepDirective,
  snapshotCwd: string,
): string {
  return step.cwd?.trim() || snapshotCwd.trim() || ".";
}

function getExecutionStatus(
  result: AiTerminalExecutionResult,
): AiTerminalExecutionDisplayState {
  if (result.timedOut) {
    return "failed";
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return "failed";
  }
  return "completed";
}

export async function runApprovedAiTerminalStep(
  input: RunApprovedAiTerminalStepInput,
  deps: Partial<RunApprovedAiTerminalStepDeps> = {},
): Promise<RunApprovedAiTerminalStepResult> {
  const resolvedDeps: RunApprovedAiTerminalStepDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const snapshot = await resolvedDeps.getTerminalSnapshot(input.terminalId);
  const startedAt = resolvedDeps.now();
  const fallbackCwd = getFallbackCwd(input.step, snapshot.cwd);
  const pendingExecution: AiTerminalStepExecution = {
    terminalId: input.terminalId,
    stepId: input.step.stepId,
    command: input.step.command,
    cwd: fallbackCwd,
    status: "running",
    startSeq: snapshot.seq,
    startOffset: snapshot.output.length,
    startedAt,
    completedAt: null,
    frozenOutput: null,
  };

  input.onStart?.(pendingExecution);

  const runResult = await resolvedDeps.runInTerminal(
    buildAiTerminalExecutionWrapper({
      command: input.step.command,
      cwd: input.step.cwd?.trim() || null,
    }),
    {
      terminalId: input.terminalId,
      timeoutMs: APPROVED_AI_TERMINAL_TIMEOUT_MS,
      untilPattern: AI_TERMINAL_RESULT_MARKER_OSC_PREFIX,
    },
  );

  const parsedResult = parseAiTerminalExecutionResult({
    stepId: input.step.stepId,
    rawOutput: runResult.output,
    timedOut: runResult.timedOut,
    fallbackCwd,
  });
  const cleanRawOutput = cleanAiTerminalExecutionOutput(
    parsedResult.rawOutput,
    input.step.command,
  );
  const cleanSummary = summarizeAiTerminalOutput(cleanRawOutput);
  const result: AiTerminalExecutionResult = {
    ...parsedResult,
    rawOutput: cleanRawOutput,
    outputSummary: cleanSummary.outputSummary,
    errorSummary: cleanSummary.errorSummary,
  };
  const completedAt = resolvedDeps.now();
  const execution: AiTerminalStepExecution = {
    ...pendingExecution,
    cwd: result.cwdAfter,
    status: getExecutionStatus(result),
    completedAt,
    frozenOutput: result.rawOutput,
  };

  return {
    execution,
    result,
    runResult,
  };
}
