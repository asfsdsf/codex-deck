import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getCodexDir } from "./storage";
import type {
  TerminalPersistFrozenBlockRequest,
  TerminalPersistFrozenBlockResponse,
  TerminalPersistMessageActionRequest,
  TerminalPersistMessageActionResponse,
  TerminalSessionArtifactsManifest,
  TerminalSessionArtifactsResponse,
  TerminalSessionBlockType,
  TerminalSessionBlockRecord,
  TerminalSessionBlockRecordWithSnapshot,
  TerminalSessionMessageActionDecision,
  TerminalSessionPlanExecutionFeedback,
  TerminalSessionPlanRejectionFeedback,
  TerminalSessionPlanStep,
  TerminalSessionPlanStepAction,
  TerminalSessionPlanStepFeedback,
  TerminalSerializedSnapshot,
  TerminalSnapshotCaptureKind,
  TerminalSnapshotFormat,
} from "./storage";

const TERMINAL_SESSIONS_DIRNAME = "codex-deck/terminal/sessions";
const TERMINAL_SESSION_MANIFEST_FILE = "session.json";
const TERMINAL_SESSION_BLOCKS_DIRNAME = "blocks";

type JsonObject = Record<string, unknown>;

interface NormalizedPersistBlockInput {
  terminalId: string;
  sessionId: string;
  captureKind: TerminalSnapshotCaptureKind;
  messageKey: string | null;
  stepId: string | null;
  snapshot: TerminalSerializedSnapshot;
  sequence: number | null;
}

interface NormalizedPersistMessageBlockInput {
  terminalId: string;
  sessionId: string;
  type: Exclude<TerminalSessionBlockType, "terminal_snapshot">;
  messageKey: string;
  sequence: number | null;
  leadingMarkdown: string | null;
  trailingMarkdown: string | null;
  rawBlock: string;
  contextNote: string | null;
  message: string | null;
  question: string | null;
  steps: TerminalSessionPlanStep[] | null;
  stepFeedback: TerminalSessionPlanStepFeedback[] | null;
}

interface NormalizedPersistActionInput {
  terminalId: string;
  sessionId: string;
  messageKey: string;
  stepId: string;
  decision: TerminalSessionMessageActionDecision;
  reason: string | null;
}

const terminalOperationQueues = new Map<string, Promise<unknown>>();

function queueTerminalSessionOperation<T>(
  terminalId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const current = terminalOperationQueues.get(terminalId) ?? Promise.resolve();
  const next = current.then(operation, operation);
  terminalOperationQueues.set(
    terminalId,
    next.finally(() => {
      if (terminalOperationQueues.get(terminalId) === next) {
        terminalOperationQueues.delete(terminalId);
      }
    }),
  );
  return next;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveCodexHome(codexHome?: string | null): string {
  const normalized = codexHome?.trim();
  if (normalized) {
    return normalized;
  }
  const current = getCodexDir()?.trim();
  if (current) {
    return current;
  }
  return join(homedir(), ".codex");
}

function getTerminalSessionsDir(codexHome?: string | null): string {
  return join(resolveCodexHome(codexHome), TERMINAL_SESSIONS_DIRNAME);
}

function getTerminalSessionDir(
  terminalId: string,
  codexHome?: string | null,
): string {
  return join(getTerminalSessionsDir(codexHome), terminalId);
}

function getTerminalSessionManifestPath(
  terminalId: string,
  codexHome?: string | null,
): string {
  return join(
    getTerminalSessionDir(terminalId, codexHome),
    TERMINAL_SESSION_MANIFEST_FILE,
  );
}

function getTerminalSessionBlocksDir(
  terminalId: string,
  codexHome?: string | null,
): string {
  return join(
    getTerminalSessionDir(terminalId, codexHome),
    TERMINAL_SESSION_BLOCKS_DIRNAME,
  );
}

async function ensureTerminalSessionDirs(
  terminalId: string,
  codexHome?: string | null,
): Promise<{ sessionDir: string; blocksDir: string }> {
  const sessionDir = getTerminalSessionDir(terminalId, codexHome);
  const blocksDir = getTerminalSessionBlocksDir(terminalId, codexHome);
  await mkdir(blocksDir, { recursive: true });
  return { sessionDir, blocksDir };
}

async function writeTextFileAtomic(path: string, text: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tempPath, text, "utf-8");
  await rename(tempPath, path);
}

function generateBlockId(): string {
  return `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeDecision(
  value: unknown,
): TerminalSessionMessageActionDecision | null {
  return value === "approved" || value === "rejected" ? value : null;
}

function normalizeSnapshotCaptureKind(
  value: unknown,
): TerminalSnapshotCaptureKind | null {
  return value === "manual" ? "manual" : null;
}

function normalizePlanStepAction(
  value: unknown,
): TerminalSessionPlanStepAction | null {
  const record = asRecord(value);
  const stepId = asString(record.stepId);
  const decision = normalizeDecision(record.decision);
  const updatedAt = asString(record.updatedAt);
  if (!stepId || !decision || !updatedAt) {
    return null;
  }
  return {
    stepId,
    decision,
    reason: record.reason === null ? null : asString(record.reason),
    updatedAt,
  };
}

function normalizePlanStep(value: unknown): TerminalSessionPlanStep | null {
  const record = asRecord(value);
  const stepId = asString(record.stepId);
  const command = asString(record.command);
  const risk = asString(record.risk);
  const nextAction = asString(record.nextAction);
  if (
    !stepId ||
    !command ||
    (risk !== "low" && risk !== "medium" && risk !== "high") ||
    (nextAction !== "approve" &&
      nextAction !== "reject" &&
      nextAction !== "provide_input")
  ) {
    return null;
  }
  return {
    stepId,
    stepGoal:
      record.stepGoal === null ? null : (asString(record.stepGoal) ?? null),
    command,
    explanation:
      record.explanation === null
        ? null
        : (asString(record.explanation) ?? null),
    cwd: record.cwd === null ? null : (asString(record.cwd) ?? null),
    shell: record.shell === null ? null : (asString(record.shell) ?? null),
    risk,
    nextAction,
    contextNote:
      record.contextNote === null
        ? null
        : (asString(record.contextNote) ?? null),
  };
}

function normalizePlanStepExecutionFeedback(
  value: unknown,
): TerminalSessionPlanExecutionFeedback | null {
  const record = asRecord(value);
  const stepId = asString(record.stepId);
  const updatedAt = asString(record.updatedAt);
  const status = asString(record.status);
  if (
    !stepId ||
    !updatedAt ||
    (status !== "success" &&
      status !== "failed" &&
      status !== "timed_out" &&
      status !== "completed_unknown")
  ) {
    return null;
  }
  return {
    kind: "execution",
    stepId,
    updatedAt,
    status,
    exitCode:
      typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
        ? record.exitCode
        : null,
    cwdAfter:
      record.cwdAfter === null ? null : (asString(record.cwdAfter) ?? null),
    outputSummary:
      record.outputSummary === null
        ? null
        : (asString(record.outputSummary) ?? null),
    errorSummary:
      record.errorSummary === null
        ? null
        : (asString(record.errorSummary) ?? null),
    outputReference:
      record.outputReference === null
        ? null
        : (asString(record.outputReference) ?? null),
  };
}

function normalizePlanStepRejectionFeedback(
  value: unknown,
): TerminalSessionPlanRejectionFeedback | null {
  const record = asRecord(value);
  const stepId = asString(record.stepId);
  const updatedAt = asString(record.updatedAt);
  const decision = asString(record.decision);
  if (!stepId || !updatedAt || decision !== "rejected") {
    return null;
  }
  return {
    kind: "rejection",
    stepId,
    updatedAt,
    decision: "rejected",
    reason: record.reason === null ? null : (asString(record.reason) ?? null),
  };
}

function normalizePlanStepFeedback(
  value: unknown,
): TerminalSessionPlanStepFeedback | null {
  const record = asRecord(value);
  const kind = asString(record.kind);
  if (kind === "execution") {
    return normalizePlanStepExecutionFeedback(record);
  }
  if (kind === "rejection") {
    return normalizePlanStepRejectionFeedback(record);
  }
  return null;
}

function normalizeBlockRecord(
  value: unknown,
): TerminalSessionBlockRecord | null {
  const record = asRecord(value);
  const blockId = asString(record.blockId);
  const terminalId = asString(record.terminalId);
  const sessionId = asString(record.sessionId);
  const type = asString(record.type);
  const createdAt = asString(record.createdAt);
  const updatedAt = asString(record.updatedAt);
  const messageKey =
    record.messageKey === null ? null : (asString(record.messageKey) ?? null);
  const stepId =
    record.stepId === null ? null : (asString(record.stepId) ?? null);
  const snapshotPath =
    record.snapshotPath === null
      ? null
      : (asString(record.snapshotPath) ?? null);
  const snapshotFormat =
    record.snapshotFormat === null
      ? null
      : normalizeSnapshotFormat(record.snapshotFormat);
  const cols =
    typeof record.cols === "number" && Number.isFinite(record.cols)
      ? record.cols
      : null;
  const rows =
    typeof record.rows === "number" && Number.isFinite(record.rows)
      ? record.rows
      : null;
  const snapshotLength =
    typeof record.snapshotLength === "number" &&
    Number.isFinite(record.snapshotLength)
      ? record.snapshotLength
      : null;
  const sequence =
    typeof record.sequence === "number" && Number.isFinite(record.sequence)
      ? record.sequence
      : null;
  const captureKind =
    record.captureKind === null
      ? null
      : normalizeSnapshotCaptureKind(record.captureKind);
  const leadingMarkdown =
    record.leadingMarkdown === null
      ? null
      : (asString(record.leadingMarkdown) ?? null);
  const trailingMarkdown =
    record.trailingMarkdown === null
      ? null
      : (asString(record.trailingMarkdown) ?? null);
  const rawBlock =
    record.rawBlock === null ? null : (asString(record.rawBlock) ?? null);
  const contextNote =
    record.contextNote === null ? null : (asString(record.contextNote) ?? null);
  const message =
    record.message === null ? null : (asString(record.message) ?? null);
  const question =
    record.question === null ? null : (asString(record.question) ?? null);
  const steps = Array.isArray(record.steps)
    ? record.steps
        .map((step) => normalizePlanStep(step))
        .filter((step): step is TerminalSessionPlanStep => step !== null)
    : null;
  const stepActions = Array.isArray(record.stepActions)
    ? record.stepActions
        .map((step) => normalizePlanStepAction(step))
        .filter((step): step is TerminalSessionPlanStepAction => step !== null)
    : null;
  const stepFeedback = Array.isArray(record.stepFeedback)
    ? record.stepFeedback
        .map((entry) => normalizePlanStepFeedback(entry))
        .filter(
          (entry): entry is TerminalSessionPlanStepFeedback => entry !== null,
        )
    : null;

  if (
    !blockId ||
    !terminalId ||
    !sessionId ||
    (type !== "terminal_snapshot" &&
      type !== "ai_terminal_plan" &&
      type !== "ai_terminal_need_input" &&
      type !== "ai_terminal_complete") ||
    !createdAt ||
    !updatedAt ||
    sequence === null
  ) {
    return null;
  }

  if (type === "terminal_snapshot") {
    if (
      !snapshotPath ||
      !snapshotFormat ||
      cols === null ||
      rows === null ||
      snapshotLength === null ||
      !captureKind
    ) {
      return null;
    }
  }

  if (
    (type === "ai_terminal_plan" ||
      type === "ai_terminal_need_input" ||
      type === "ai_terminal_complete") &&
    !messageKey
  ) {
    return null;
  }

  return {
    blockId,
    terminalId,
    sessionId,
    type,
    sequence,
    createdAt,
    updatedAt,
    messageKey,
    stepId,
    snapshotPath,
    snapshotFormat,
    cols,
    rows,
    snapshotLength,
    captureKind,
    leadingMarkdown,
    trailingMarkdown,
    rawBlock,
    contextNote,
    message,
    question,
    steps,
    stepActions,
    stepFeedback,
  };
}

function normalizeSnapshotFormat(
  value: unknown,
): TerminalSnapshotFormat | null {
  return value === "xterm-serialize-v1" ? value : null;
}

function createEmptyManifest(
  terminalId: string,
  timestamp = new Date().toISOString(),
): TerminalSessionArtifactsManifest {
  return {
    terminalId,
    createdAt: timestamp,
    updatedAt: timestamp,
    blocks: [],
  };
}

function sortBlocks(
  blocks: TerminalSessionBlockRecord[],
): TerminalSessionBlockRecord[] {
  return [...blocks].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.blockId.localeCompare(right.blockId);
  });
}

function normalizeManifest(
  value: unknown,
  terminalId: string,
): TerminalSessionArtifactsManifest {
  const record = asRecord(value);
  const createdAt = asString(record.createdAt) ?? new Date().toISOString();
  const updatedAt = asString(record.updatedAt) ?? createdAt;
  const blocks = Array.isArray(record.blocks)
    ? record.blocks
        .map((block) => normalizeBlockRecord(block))
        .filter((block): block is TerminalSessionBlockRecord => block !== null)
    : [];
  return {
    terminalId,
    createdAt,
    updatedAt,
    blocks: sortBlocks(blocks),
  };
}

async function readManifest(
  terminalId: string,
  codexHome?: string | null,
): Promise<TerminalSessionArtifactsManifest> {
  try {
    const text = await readFile(
      getTerminalSessionManifestPath(terminalId, codexHome),
      "utf-8",
    );
    return normalizeManifest(JSON.parse(text), terminalId);
  } catch {
    return createEmptyManifest(terminalId);
  }
}

function writeManifestText(manifest: TerminalSessionArtifactsManifest): string {
  return JSON.stringify(
    {
      terminalId: manifest.terminalId,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      blocks: sortBlocks(manifest.blocks),
    },
    null,
    2,
  );
}

async function writeManifest(
  terminalId: string,
  manifest: TerminalSessionArtifactsManifest,
  codexHome?: string | null,
): Promise<void> {
  await ensureTerminalSessionDirs(terminalId, codexHome);
  await writeTextFileAtomic(
    getTerminalSessionManifestPath(terminalId, codexHome),
    writeManifestText(manifest),
  );
}

function normalizePersistBlockInput(
  input: {
    terminalId: string;
  } & TerminalPersistFrozenBlockRequest,
): NormalizedPersistBlockInput {
  const terminalId = input.terminalId.trim();
  const sessionId = input.sessionId.trim();
  const snapshot = input.snapshot;
  const messageKey = input.messageKey?.trim() || null;
  const stepId = input.stepId?.trim() || null;
  const captureKind =
    normalizeSnapshotCaptureKind(input.captureKind) ?? "manual";
  const sequence =
    typeof input.sequence === "number" && Number.isFinite(input.sequence)
      ? input.sequence
      : null;

  if (!terminalId) {
    throw new Error("terminalId is required");
  }
  if (!sessionId) {
    throw new Error("sessionId is required");
  }
  if (
    !snapshot ||
    normalizeSnapshotFormat(snapshot.format) === null ||
    typeof snapshot.data !== "string" ||
    snapshot.data.length === 0 ||
    !Number.isFinite(snapshot.cols) ||
    snapshot.cols < 2 ||
    !Number.isFinite(snapshot.rows) ||
    snapshot.rows < 2
  ) {
    throw new Error("snapshot must be a valid serialized terminal snapshot");
  }

  return {
    terminalId,
    sessionId,
    captureKind,
    messageKey,
    stepId,
    snapshot: {
      format: snapshot.format,
      cols: Math.floor(snapshot.cols),
      rows: Math.floor(snapshot.rows),
      data: snapshot.data,
    },
    sequence,
  };
}

function normalizePersistMessageBlockInput(input: {
  terminalId: string;
  sessionId: string;
  type: Exclude<TerminalSessionBlockType, "terminal_snapshot">;
  messageKey: string;
  sequence?: number | null;
  leadingMarkdown?: string | null;
  trailingMarkdown?: string | null;
  rawBlock: string;
  contextNote?: string | null;
  message?: string | null;
  question?: string | null;
  steps?: TerminalSessionPlanStep[] | null;
  stepFeedback?: TerminalSessionPlanStepFeedback[] | null;
}): NormalizedPersistMessageBlockInput {
  const terminalId = input.terminalId.trim();
  const sessionId = input.sessionId.trim();
  const messageKey = input.messageKey.trim();
  const rawBlock = input.rawBlock.trim();
  const type = input.type;
  const sequence =
    typeof input.sequence === "number" && Number.isFinite(input.sequence)
      ? input.sequence
      : null;
  if (!terminalId) {
    throw new Error("terminalId is required");
  }
  if (!sessionId) {
    throw new Error("sessionId is required");
  }
  if (!messageKey) {
    throw new Error("messageKey is required");
  }
  if (!rawBlock) {
    throw new Error("rawBlock is required");
  }
  if (
    type !== "ai_terminal_plan" &&
    type !== "ai_terminal_need_input" &&
    type !== "ai_terminal_complete"
  ) {
    throw new Error("type must be an AI terminal message block");
  }

  return {
    terminalId,
    sessionId,
    type,
    messageKey,
    sequence,
    leadingMarkdown: input.leadingMarkdown?.trim() || null,
    trailingMarkdown: input.trailingMarkdown?.trim() || null,
    rawBlock,
    contextNote: input.contextNote?.trim() || null,
    message: input.message?.trim() || null,
    question: input.question?.trim() || null,
    steps: input.steps?.map((step) => ({ ...step })) ?? null,
    stepFeedback: input.stepFeedback?.map((entry) => ({ ...entry })) ?? null,
  };
}

function normalizePersistActionInput(
  input: {
    terminalId: string;
  } & TerminalPersistMessageActionRequest,
): NormalizedPersistActionInput {
  const terminalId = input.terminalId.trim();
  const sessionId = input.sessionId.trim();
  const messageKey = input.messageKey.trim();
  const stepId = input.stepId.trim();
  const decision = normalizeDecision(input.decision);
  const reason =
    input.reason === undefined || input.reason === null ? null : input.reason;

  if (!terminalId) {
    throw new Error("terminalId is required");
  }
  if (!sessionId) {
    throw new Error("sessionId is required");
  }
  if (!messageKey) {
    throw new Error("messageKey is required");
  }
  if (!stepId) {
    throw new Error("stepId is required");
  }
  if (!decision) {
    throw new Error("decision is required");
  }

  return {
    terminalId,
    sessionId,
    messageKey,
    stepId,
    decision,
    reason,
  };
}

function findExistingBlockIndex(
  blocks: TerminalSessionBlockRecord[],
  input:
    | Pick<NormalizedPersistBlockInput, "sessionId" | "messageKey" | "stepId">
    | Pick<
        NormalizedPersistMessageBlockInput,
        "type" | "sessionId" | "messageKey"
      >,
): number {
  if ("type" in input) {
    return blocks.findIndex(
      (block) =>
        block.type === input.type &&
        block.sessionId === input.sessionId &&
        block.messageKey === input.messageKey,
    );
  }

  return blocks.findIndex(
    (block) =>
      block.type === "terminal_snapshot" &&
      block.sessionId === input.sessionId &&
      (block.messageKey ?? null) === (input.messageKey ?? null) &&
      (block.stepId ?? null) === (input.stepId ?? null),
  );
}

async function readBlockSnapshot(
  terminalId: string,
  block: TerminalSessionBlockRecord,
  codexHome?: string | null,
): Promise<TerminalSerializedSnapshot | null> {
  if (
    !block.snapshotPath ||
    !block.snapshotFormat ||
    block.cols === null ||
    block.rows === null
  ) {
    return null;
  }
  try {
    const data = await readFile(
      join(getTerminalSessionDir(terminalId, codexHome), block.snapshotPath),
      "utf-8",
    );
    return {
      format: block.snapshotFormat,
      cols: block.cols,
      rows: block.rows,
      data,
    };
  } catch {
    return null;
  }
}

function createMessageAction(
  existing: TerminalSessionPlanStepAction[] | null,
  step: TerminalSessionPlanStepAction,
): TerminalSessionPlanStepAction[] {
  const steps =
    existing?.filter((candidate) => candidate.stepId !== step.stepId) ?? [];
  return [...steps, step];
}

function upsertStepFeedback(
  existing: TerminalSessionPlanStepFeedback[] | null,
  step: TerminalSessionPlanStepFeedback,
): TerminalSessionPlanStepFeedback[] {
  const entries =
    existing?.filter(
      (candidate) =>
        !(
          candidate.stepId === step.stepId &&
          ((candidate.kind === "execution" && step.kind === "execution") ||
            (candidate.kind === "rejection" && step.kind === "rejection"))
        ),
    ) ?? [];
  return [...entries, step];
}

export async function persistTerminalSessionFrozenBlock(
  input: {
    terminalId: string;
  } & TerminalPersistFrozenBlockRequest,
  codexHome?: string | null,
): Promise<TerminalPersistFrozenBlockResponse> {
  const normalized = normalizePersistBlockInput(input);

  return queueTerminalSessionOperation(normalized.terminalId, async () => {
    const manifest = await readManifest(normalized.terminalId, codexHome);
    const blockId = generateBlockId();
    const createdAt = new Date().toISOString();
    const updatedAt = createdAt;
    const sequence =
      normalized.sequence ??
      (manifest.blocks.length > 0
        ? Math.max(...manifest.blocks.map((block) => block.sequence)) + 1
        : 1);
    const snapshotPath = `blocks/${blockId}.snapshot`;

    const { sessionDir } = await ensureTerminalSessionDirs(
      normalized.terminalId,
      codexHome,
    );
    await writeTextFileAtomic(
      join(sessionDir, snapshotPath),
      normalized.snapshot.data,
    );

    const block: TerminalSessionBlockRecord = {
      blockId,
      terminalId: normalized.terminalId,
      sessionId: normalized.sessionId,
      type: "terminal_snapshot",
      sequence,
      createdAt,
      updatedAt,
      messageKey: normalized.messageKey,
      stepId: normalized.stepId,
      snapshotPath,
      snapshotFormat: normalized.snapshot.format,
      cols: normalized.snapshot.cols,
      rows: normalized.snapshot.rows,
      snapshotLength: normalized.snapshot.data.length,
      captureKind: normalized.captureKind,
      leadingMarkdown: null,
      trailingMarkdown: null,
      rawBlock: null,
      contextNote: null,
      message: null,
      question: null,
      steps: null,
      stepActions: null,
      stepFeedback: null,
    };

    const nextBlocks = [...manifest.blocks, block];

    const nextManifest: TerminalSessionArtifactsManifest = {
      terminalId: normalized.terminalId,
      createdAt: manifest.createdAt,
      updatedAt,
      blocks: sortBlocks(nextBlocks),
    };
    await writeManifest(normalized.terminalId, nextManifest, codexHome);

    return { block };
  });
}

export async function persistTerminalSessionMessageBlock(
  input: {
    terminalId: string;
    sessionId: string;
    type: Exclude<TerminalSessionBlockType, "terminal_snapshot">;
    messageKey: string;
    sequence?: number | null;
    leadingMarkdown?: string | null;
    trailingMarkdown?: string | null;
    rawBlock: string;
    contextNote?: string | null;
    message?: string | null;
    question?: string | null;
    steps?: TerminalSessionPlanStep[] | null;
    stepFeedback?: TerminalSessionPlanStepFeedback[] | null;
  },
  codexHome?: string | null,
): Promise<{ block: TerminalSessionBlockRecord }> {
  const normalized = normalizePersistMessageBlockInput(input);

  return queueTerminalSessionOperation(normalized.terminalId, async () => {
    const manifest = await readManifest(normalized.terminalId, codexHome);
    const existingIndex = findExistingBlockIndex(manifest.blocks, normalized);
    const existingBlock =
      existingIndex >= 0 ? manifest.blocks[existingIndex] : null;
    const updatedAt = new Date().toISOString();
    const block: TerminalSessionBlockRecord = {
      blockId: existingBlock?.blockId ?? generateBlockId(),
      terminalId: normalized.terminalId,
      sessionId: normalized.sessionId,
      type: normalized.type,
      sequence:
        normalized.sequence ??
        existingBlock?.sequence ??
        (manifest.blocks.length > 0
          ? Math.max(...manifest.blocks.map((item) => item.sequence)) + 1
          : 1),
      createdAt: existingBlock?.createdAt ?? updatedAt,
      updatedAt,
      messageKey: normalized.messageKey,
      stepId: null,
      snapshotPath: null,
      snapshotFormat: null,
      cols: null,
      rows: null,
      snapshotLength: null,
      captureKind: null,
      leadingMarkdown: normalized.leadingMarkdown,
      trailingMarkdown: normalized.trailingMarkdown,
      rawBlock: normalized.rawBlock,
      contextNote: normalized.contextNote,
      message: normalized.message,
      question: normalized.question,
      steps: normalized.type === "ai_terminal_plan" ? normalized.steps : null,
      stepActions:
        normalized.type === "ai_terminal_plan"
          ? (existingBlock?.stepActions ?? null)
          : null,
      stepFeedback:
        normalized.type === "ai_terminal_plan" ? normalized.stepFeedback : null,
    };

    const nextBlocks = [...manifest.blocks];
    if (existingIndex >= 0) {
      nextBlocks[existingIndex] = block;
    } else {
      nextBlocks.push(block);
    }

    const nextManifest: TerminalSessionArtifactsManifest = {
      terminalId: normalized.terminalId,
      createdAt: manifest.createdAt,
      updatedAt,
      blocks: sortBlocks(nextBlocks),
    };
    await writeManifest(normalized.terminalId, nextManifest, codexHome);
    return { block };
  });
}

export async function persistTerminalSessionMessageAction(
  input: {
    terminalId: string;
  } & TerminalPersistMessageActionRequest,
  codexHome?: string | null,
): Promise<TerminalPersistMessageActionResponse> {
  const normalized = normalizePersistActionInput(input);

  return queueTerminalSessionOperation(normalized.terminalId, async () => {
    const manifest = await readManifest(normalized.terminalId, codexHome);
    const existingIndex = manifest.blocks.findIndex(
      (block) =>
        block.type === "ai_terminal_plan" &&
        block.sessionId === normalized.sessionId &&
        block.messageKey === normalized.messageKey,
    );
    const existingBlock =
      existingIndex >= 0 ? manifest.blocks[existingIndex] : null;
    if (!existingBlock) {
      throw new Error(
        `plan block not found for messageKey ${normalized.messageKey}`,
      );
    }
    const updatedAt = new Date().toISOString();
    const actionStep: TerminalSessionPlanStepAction = {
      stepId: normalized.stepId,
      decision: normalized.decision,
      reason: normalized.reason,
      updatedAt,
    };
    const block: TerminalSessionBlockRecord = {
      blockId: existingBlock.blockId,
      terminalId: normalized.terminalId,
      sessionId: normalized.sessionId,
      type: "ai_terminal_plan",
      sequence: existingBlock.sequence,
      createdAt: existingBlock.createdAt,
      updatedAt,
      messageKey: normalized.messageKey,
      stepId: existingBlock.stepId,
      snapshotPath: existingBlock.snapshotPath,
      snapshotFormat: existingBlock.snapshotFormat,
      cols: existingBlock.cols,
      rows: existingBlock.rows,
      snapshotLength: existingBlock.snapshotLength,
      captureKind: existingBlock.captureKind,
      leadingMarkdown: existingBlock.leadingMarkdown,
      trailingMarkdown: existingBlock.trailingMarkdown,
      rawBlock: existingBlock.rawBlock,
      contextNote: existingBlock.contextNote,
      message: existingBlock.message,
      question: existingBlock.question,
      steps: existingBlock.steps,
      stepActions: createMessageAction(
        existingBlock.stepActions ?? null,
        actionStep,
      ),
      stepFeedback:
        normalized.decision === "rejected"
          ? upsertStepFeedback(existingBlock.stepFeedback ?? null, {
              kind: "rejection",
              stepId: normalized.stepId,
              updatedAt,
              decision: "rejected",
              reason: normalized.reason,
            })
          : existingBlock.stepFeedback,
    };

    const nextBlocks = [...manifest.blocks];
    if (existingIndex >= 0) {
      nextBlocks[existingIndex] = block;
    } else {
      nextBlocks.push(block);
    }

    const nextManifest: TerminalSessionArtifactsManifest = {
      terminalId: normalized.terminalId,
      createdAt: manifest.createdAt,
      updatedAt,
      blocks: sortBlocks(nextBlocks),
    };
    await writeManifest(normalized.terminalId, nextManifest, codexHome);

    return {
      terminalId: normalized.terminalId,
      sessionId: normalized.sessionId,
      messageKey: normalized.messageKey,
      stepActions: block.stepActions ?? [],
    };
  });
}

export async function getPersistedTerminalSessionArtifacts(
  terminalId: string,
  options?: {
    sessionId?: string | null;
  },
  codexHome?: string | null,
): Promise<TerminalSessionArtifactsResponse> {
  const normalizedTerminalId = terminalId.trim();
  if (!normalizedTerminalId) {
    throw new Error("terminalId is required");
  }
  const sessionId = options?.sessionId?.trim() || null;
  const manifest = await readManifest(normalizedTerminalId, codexHome);
  const filteredBlocks = manifest.blocks.filter((block) =>
    sessionId ? block.sessionId === sessionId : true,
  );
  const blocks: TerminalSessionBlockRecordWithSnapshot[] = [];

  for (const block of filteredBlocks) {
    blocks.push({
      ...block,
      snapshot: await readBlockSnapshot(normalizedTerminalId, block, codexHome),
    });
  }

  return {
    terminalId: normalizedTerminalId,
    sessionId,
    manifest: {
      terminalId: manifest.terminalId,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
      blocks: filteredBlocks,
    },
    blocks,
    timelineEntries: [],
  };
}

export async function removeTerminalSessionArtifacts(
  terminalId: string,
  codexHome?: string | null,
): Promise<void> {
  const normalized = terminalId.trim();
  if (!normalized) {
    return;
  }
  await queueTerminalSessionOperation(normalized, async () => {
    await rm(getTerminalSessionDir(normalized, codexHome), {
      recursive: true,
      force: true,
    });
  });
}

export function removeTerminalSessionArtifactsSync(
  terminalId: string,
  codexHome?: string | null,
): void {
  const normalized = terminalId.trim();
  if (!normalized) {
    return;
  }
  rmSync(getTerminalSessionDir(normalized, codexHome), {
    recursive: true,
    force: true,
  });
}

export function readPersistedTerminalSessionManifestSync(
  terminalId: string,
  codexHome?: string | null,
): TerminalSessionArtifactsManifest {
  const normalized = terminalId.trim();
  if (!normalized) {
    throw new Error("terminalId is required");
  }

  try {
    const text = readFileSync(
      getTerminalSessionManifestPath(normalized, codexHome),
      "utf-8",
    );
    return normalizeManifest(JSON.parse(text), normalized);
  } catch {
    return createEmptyManifest(normalized);
  }
}

export function hasPersistedTerminalSessionArtifacts(
  terminalId: string,
  codexHome?: string | null,
): boolean {
  const normalized = terminalId.trim();
  if (!normalized) {
    return false;
  }
  return existsSync(getTerminalSessionManifestPath(normalized, codexHome));
}
