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
  TerminalSessionBlockKind,
  TerminalSessionBlockRecord,
  TerminalSessionBlockRecordWithTranscript,
  TerminalSessionMessageAction,
  TerminalSessionMessageActionDecision,
  TerminalSessionMessageActionStep,
} from "./storage";

const TERMINAL_SESSIONS_DIRNAME = "codex-deck/terminal/sessions";
const TERMINAL_SESSION_MANIFEST_FILE = "session.json";
const TERMINAL_SESSION_BLOCKS_DIRNAME = "blocks";

type JsonObject = Record<string, unknown>;

interface NormalizedPersistBlockInput {
  terminalId: string;
  sessionId: string;
  kind: TerminalSessionBlockKind;
  messageKey: string | null;
  stepId: string | null;
  transcript: string;
  sequence: number | null;
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

function normalizeActionStep(value: unknown): TerminalSessionMessageActionStep | null {
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

function normalizeAction(value: unknown): TerminalSessionMessageAction | null {
  const record = asRecord(value);
  if (asString(record.kind) !== "ai-terminal-step-actions") {
    return null;
  }
  if (!Array.isArray(record.steps)) {
    return null;
  }
  const steps = record.steps
    .map((step) => normalizeActionStep(step))
    .filter((step): step is TerminalSessionMessageActionStep => step !== null);
  return steps.length > 0
    ? {
        kind: "ai-terminal-step-actions",
        steps,
      }
    : null;
}

function normalizeBlockRecord(value: unknown): TerminalSessionBlockRecord | null {
  const record = asRecord(value);
  const blockId = asString(record.blockId);
  const terminalId = asString(record.terminalId);
  const sessionId = asString(record.sessionId);
  const kind = asString(record.kind);
  const createdAt = asString(record.createdAt);
  const updatedAt = asString(record.updatedAt);
  const messageKey =
    record.messageKey === null ? null : (asString(record.messageKey) ?? null);
  const stepId =
    record.stepId === null ? null : (asString(record.stepId) ?? null);
  const transcriptPath =
    record.transcriptPath === null
      ? null
      : (asString(record.transcriptPath) ?? null);
  const transcriptLength =
    typeof record.transcriptLength === "number" &&
    Number.isFinite(record.transcriptLength)
      ? record.transcriptLength
      : null;
  const sequence =
    typeof record.sequence === "number" && Number.isFinite(record.sequence)
      ? record.sequence
      : null;

  if (
    !blockId ||
    !terminalId ||
    !sessionId ||
    (kind !== "execution" && kind !== "manual") ||
    !createdAt ||
    !updatedAt ||
    transcriptLength === null ||
    sequence === null
  ) {
    return null;
  }

  return {
    blockId,
    terminalId,
    sessionId,
    kind,
    sequence,
    createdAt,
    updatedAt,
    messageKey,
    stepId,
    transcriptPath,
    transcriptLength,
    action: normalizeAction(record.action),
  };
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

function sortBlocks(blocks: TerminalSessionBlockRecord[]): TerminalSessionBlockRecord[] {
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
      blocks: sortBlocks(manifest.blocks).map((block) => ({
        ...block,
        action: block.action,
      })),
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

function normalizePersistBlockInput(input: {
  terminalId: string;
} & TerminalPersistFrozenBlockRequest): NormalizedPersistBlockInput {
  const terminalId = input.terminalId.trim();
  const sessionId = input.sessionId.trim();
  const transcript = input.transcript;
  const messageKey = input.messageKey?.trim() || null;
  const stepId = input.stepId?.trim() || null;
  const kind =
    input.kind === "manual" || input.kind === "execution"
      ? input.kind
      : messageKey
        ? "execution"
        : "manual";
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
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new Error("transcript must be a non-empty string");
  }
  if (kind === "execution" && !messageKey) {
    throw new Error("messageKey is required for execution blocks");
  }

  return {
    terminalId,
    sessionId,
    kind,
    messageKey,
    stepId,
    transcript,
    sequence,
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
    input.reason === undefined || input.reason === null
      ? null
      : input.reason;

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
  input: Pick<NormalizedPersistBlockInput, "kind" | "sessionId" | "messageKey" | "stepId">,
): number {
  if (input.kind === "execution") {
    return blocks.findIndex(
      (block) =>
        block.kind === "execution" &&
        block.sessionId === input.sessionId &&
        block.messageKey === input.messageKey &&
        (block.stepId ?? null) === (input.stepId ?? null),
    );
  }

  if (input.messageKey) {
    return blocks.findIndex(
      (block) =>
        block.kind === "manual" &&
        block.sessionId === input.sessionId &&
        block.messageKey === input.messageKey,
    );
  }

  return -1;
}

async function readBlockTranscript(
  terminalId: string,
  block: TerminalSessionBlockRecord,
  codexHome?: string | null,
): Promise<string | null> {
  if (!block.transcriptPath) {
    return null;
  }
  try {
    return await readFile(
      join(getTerminalSessionDir(terminalId, codexHome), block.transcriptPath),
      "utf-8",
    );
  } catch {
    return null;
  }
}

function createMessageAction(
  existing: TerminalSessionMessageAction | null,
  step: TerminalSessionMessageActionStep,
): TerminalSessionMessageAction {
  const steps = existing?.steps.filter(
    (candidate) => candidate.stepId !== step.stepId,
  ) ?? [];
  return {
    kind: "ai-terminal-step-actions",
    steps: [...steps, step],
  };
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
    const existingIndex = findExistingBlockIndex(manifest.blocks, normalized);
    const existingBlock =
      existingIndex >= 0 ? manifest.blocks[existingIndex] : null;
    const blockId = existingBlock?.blockId ?? generateBlockId();
    const createdAt = existingBlock?.createdAt ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const sequence =
      normalized.sequence ??
      existingBlock?.sequence ??
      (manifest.blocks.length > 0
        ? Math.max(...manifest.blocks.map((block) => block.sequence)) + 1
        : 1);
    const transcriptPath = `blocks/${blockId}.txt`;

    const { sessionDir } = await ensureTerminalSessionDirs(
      normalized.terminalId,
      codexHome,
    );
    await writeTextFileAtomic(
      join(sessionDir, transcriptPath),
      normalized.transcript,
    );

    const block: TerminalSessionBlockRecord = {
      blockId,
      terminalId: normalized.terminalId,
      sessionId: normalized.sessionId,
      kind: normalized.kind,
      sequence,
      createdAt,
      updatedAt,
      messageKey: normalized.messageKey,
      stepId: normalized.stepId,
      transcriptPath,
      transcriptLength: normalized.transcript.length,
      action: existingBlock?.action ?? null,
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
        block.kind === "execution" &&
        block.sessionId === normalized.sessionId &&
        block.messageKey === normalized.messageKey,
    );
    const existingBlock =
      existingIndex >= 0 ? manifest.blocks[existingIndex] : null;
    const updatedAt = new Date().toISOString();
    const actionStep: TerminalSessionMessageActionStep = {
      stepId: normalized.stepId,
      decision: normalized.decision,
      reason: normalized.reason,
      updatedAt,
    };
    const block: TerminalSessionBlockRecord = {
      blockId: existingBlock?.blockId ?? generateBlockId(),
      terminalId: normalized.terminalId,
      sessionId: normalized.sessionId,
      kind: "execution",
      sequence:
        existingBlock?.sequence ??
        (manifest.blocks.length > 0
          ? Math.max(...manifest.blocks.map((item) => item.sequence)) + 1
          : 1),
      createdAt: existingBlock?.createdAt ?? updatedAt,
      updatedAt,
      messageKey: normalized.messageKey,
      stepId: existingBlock?.stepId ?? null,
      transcriptPath: existingBlock?.transcriptPath ?? null,
      transcriptLength: existingBlock?.transcriptLength ?? 0,
      action: createMessageAction(existingBlock?.action ?? null, actionStep),
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
      action: block.action!,
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
  const blocks: TerminalSessionBlockRecordWithTranscript[] = [];

  for (const block of filteredBlocks) {
    blocks.push({
      ...block,
      transcript: await readBlockTranscript(normalizedTerminalId, block, codexHome),
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
