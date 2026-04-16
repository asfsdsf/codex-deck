import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { getCodexDir } from "./storage";
import type {
  TerminalPersistFrozenBlockRequest,
  TerminalPersistFrozenBlockResponse,
  TerminalSessionArtifactEntry,
  TerminalSessionArtifactEntryWithTranscript,
  TerminalSessionArtifactsManifest,
  TerminalSessionArtifactsResponse,
} from "./storage";

const TERMINAL_SESSIONS_DIRNAME = "codex-deck/terminal/sessions";
const TERMINAL_SESSION_MANIFEST_FILE = "session.json";
const TERMINAL_SESSION_BLOCKS_DIRNAME = "blocks";

type JsonObject = Record<string, unknown>;

interface PersistedCodexSessionMessageBlockRecord {
  blockId: string;
  type: "codex-session-message";
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  messageKey: string;
}

interface PersistedTerminalFrozenOutputBlockRecord {
  blockId: string;
  type: "terminal-frozen-output";
  createdAt: string;
  updatedAt: string;
  path: string;
  transcriptLength: number;
  stepId: string | null;
  source: {
    kind: "codex-session-message";
    blockId: string;
  };
}

type PersistedTerminalSessionBlockRecord =
  | PersistedCodexSessionMessageBlockRecord
  | PersistedTerminalFrozenOutputBlockRecord;

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

function normalizeTerminalSessionArtifactEntry(
  value: unknown,
): TerminalSessionArtifactEntry | null {
  const record = asRecord(value);
  const entryId = asString(record.entryId);
  const terminalId = asString(record.terminalId);
  const type = asString(record.type);
  const createdAt = asString(record.createdAt);
  const updatedAt = asString(record.updatedAt);
  const transcriptPath = asString(record.transcriptPath);
  const transcriptLength =
    typeof record.transcriptLength === "number" &&
    Number.isFinite(record.transcriptLength)
      ? record.transcriptLength
      : null;
  const reference = asRecord(record.reference);
  const referenceKind = asString(reference.kind);
  const sessionId = asString(reference.sessionId);
  const messageKey = asString(reference.messageKey);
  const stepId =
    record.stepId === null ? null : asString(record.stepId) ?? null;

  if (
    !entryId ||
    !terminalId ||
    type !== "frozen-block" ||
    !createdAt ||
    !updatedAt ||
    !transcriptPath ||
    transcriptLength === null ||
    referenceKind !== "codex-session-message" ||
    !sessionId ||
    !messageKey
  ) {
    return null;
  }

  return {
    entryId,
    terminalId,
    type: "frozen-block",
    createdAt,
    updatedAt,
    stepId,
    transcriptPath,
    transcriptLength,
    reference: {
      kind: "codex-session-message",
      sessionId,
      messageKey,
    },
  };
}

function normalizeTerminalSessionManifest(
  value: unknown,
  terminalId: string,
): TerminalSessionArtifactsManifest {
  const record = asRecord(value);
  const createdAt = asString(record.createdAt) ?? new Date().toISOString();
  const updatedAt = asString(record.updatedAt) ?? createdAt;
  const entries = normalizePersistedBlocksToArtifactEntries(
    Array.isArray(record.blocks) ? record.blocks : [],
    terminalId,
  );

  return {
    terminalId,
    createdAt,
    updatedAt,
    entries,
  };
}

function normalizeCodexSessionMessageBlockRecord(
  value: unknown,
): PersistedCodexSessionMessageBlockRecord | null {
  const record = asRecord(value);
  const blockId = asString(record.blockId);
  const type = asString(record.type);
  const createdAt = asString(record.createdAt);
  const updatedAt = asString(record.updatedAt);
  const sessionId = asString(record.sessionId);
  const messageKey = asString(record.messageKey);

  if (
    !blockId ||
    type !== "codex-session-message" ||
    !createdAt ||
    !updatedAt ||
    !sessionId ||
    !messageKey
  ) {
    return null;
  }

  return {
    blockId,
    type: "codex-session-message",
    createdAt,
    updatedAt,
    sessionId,
    messageKey,
  };
}

function normalizeTerminalFrozenOutputBlockRecord(
  value: unknown,
): PersistedTerminalFrozenOutputBlockRecord | null {
  const record = asRecord(value);
  const blockId = asString(record.blockId);
  const type = asString(record.type);
  const createdAt = asString(record.createdAt);
  const updatedAt = asString(record.updatedAt);
  const path = asString(record.path);
  const transcriptLength =
    typeof record.transcriptLength === "number" &&
    Number.isFinite(record.transcriptLength)
      ? record.transcriptLength
      : null;
  const stepId = record.stepId === null ? null : asString(record.stepId) ?? null;
  const source = asRecord(record.source);
  const sourceKind = asString(source.kind);
  const sourceBlockId = asString(source.blockId);

  if (
    !blockId ||
    type !== "terminal-frozen-output" ||
    !createdAt ||
    !updatedAt ||
    !path ||
    transcriptLength === null ||
    sourceKind !== "codex-session-message" ||
    !sourceBlockId
  ) {
    return null;
  }

  return {
    blockId,
    type: "terminal-frozen-output",
    createdAt,
    updatedAt,
    path,
    transcriptLength,
    stepId,
    source: {
      kind: "codex-session-message",
      blockId: sourceBlockId,
    },
  };
}

function normalizeLegacyCombinedBlockRecordToArtifactEntry(
  value: unknown,
  terminalId: string,
): TerminalSessionArtifactEntry | null {
  const record = asRecord(value);
  const blockId = asString(record.blockId);
  const type = asString(record.type);
  const createdAt = asString(record.createdAt);
  const updatedAt = asString(record.updatedAt);
  const reference = asRecord(record.reference);
  const referenceKind = asString(reference.kind);
  const sessionId = asString(reference.sessionId);
  const messageKey = asString(reference.messageKey);
  const frozenArtifact = asRecord(record.frozenArtifact);
  const artifactKind = asString(frozenArtifact.kind);
  const path = asString(frozenArtifact.path);
  const transcriptLength =
    typeof frozenArtifact.transcriptLength === "number" &&
    Number.isFinite(frozenArtifact.transcriptLength)
      ? frozenArtifact.transcriptLength
      : null;
  const stepId =
    frozenArtifact.stepId === null
      ? null
      : asString(frozenArtifact.stepId) ?? null;

  if (
    !blockId ||
    type !== "codex-session-block-reference" ||
    !createdAt ||
    !updatedAt ||
    referenceKind !== "codex-session-message" ||
    !sessionId ||
    !messageKey ||
    artifactKind !== "terminal-frozen-output" ||
    !path ||
    transcriptLength === null
  ) {
    return null;
  }

  return {
    entryId: blockId,
    terminalId,
    type: "frozen-block",
    createdAt,
    updatedAt,
    stepId,
    transcriptPath: path,
    transcriptLength,
    reference: {
      kind: "codex-session-message",
      sessionId,
      messageKey,
    },
  };
}

function normalizePersistedBlocksToArtifactEntries(
  blocks: unknown[],
  terminalId: string,
): TerminalSessionArtifactEntry[] {
  const messageBlocks = new Map<
    string,
    PersistedCodexSessionMessageBlockRecord
  >();

  for (const block of blocks) {
    const messageBlock = normalizeCodexSessionMessageBlockRecord(block);
    if (messageBlock) {
      messageBlocks.set(messageBlock.blockId, messageBlock);
    }
  }

  const entries: TerminalSessionArtifactEntry[] = [];
  for (const block of blocks) {
    const legacyEntry = normalizeLegacyCombinedBlockRecordToArtifactEntry(
      block,
      terminalId,
    );
    const normalizedLegacyEntry =
      legacyEntry && normalizeTerminalSessionArtifactEntry(legacyEntry);
    if (normalizedLegacyEntry) {
      entries.push(normalizedLegacyEntry);
      continue;
    }

    const frozenBlock = normalizeTerminalFrozenOutputBlockRecord(block);
    if (!frozenBlock) {
      continue;
    }

    const messageBlock = messageBlocks.get(frozenBlock.source.blockId);
    if (!messageBlock) {
      continue;
    }

    const entry = normalizeTerminalSessionArtifactEntry({
      entryId: frozenBlock.blockId,
      terminalId,
      type: "frozen-block",
      createdAt: frozenBlock.createdAt,
      updatedAt: frozenBlock.updatedAt,
      stepId: frozenBlock.stepId,
      transcriptPath: frozenBlock.path,
      transcriptLength: frozenBlock.transcriptLength,
      reference: {
        kind: "codex-session-message",
        sessionId: messageBlock.sessionId,
        messageKey: messageBlock.messageKey,
      },
    });
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function getMessageBlockId(entryId: string): string {
  return `${entryId}-message`;
}

async function writeTextFileAtomic(path: string, text: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(tempPath, text, "utf-8");
  await rename(tempPath, path);
}

const terminalSessionOperationQueues = new Map<string, Promise<void>>();

function queueTerminalSessionOperation<T>(
  terminalId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous =
    terminalSessionOperationQueues.get(terminalId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const cleanupPromise = next.finally(() => {
    if (terminalSessionOperationQueues.get(terminalId) === cleanupPromise) {
      terminalSessionOperationQueues.delete(terminalId);
    }
  });
  terminalSessionOperationQueues.set(
    terminalId,
    cleanupPromise.then(() => undefined),
  );
  return next;
}

async function readManifest(
  terminalId: string,
  codexHome?: string | null,
): Promise<TerminalSessionArtifactsManifest> {
  try {
    const manifestText = await readFile(
      getTerminalSessionManifestPath(terminalId, codexHome),
      "utf-8",
    );
    return normalizeTerminalSessionManifest(JSON.parse(manifestText), terminalId);
  } catch {
    return {
      terminalId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [],
    };
  }
}

function generateEntryId(): string {
  return `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function persistTerminalSessionFrozenBlock(
  input: {
    terminalId: string;
  } & TerminalPersistFrozenBlockRequest,
  codexHome?: string | null,
): Promise<TerminalPersistFrozenBlockResponse> {
  const terminalId = input.terminalId.trim();
  const sessionId = input.sessionId.trim();
  const messageKey = input.messageKey.trim();
  const transcript = input.transcript;
  const stepId = input.stepId?.trim() || null;

  if (!terminalId) {
    throw new Error("terminalId is required");
  }
  if (!sessionId) {
    throw new Error("sessionId is required");
  }
  if (!messageKey) {
    throw new Error("messageKey is required");
  }
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new Error("transcript must be a non-empty string");
  }

  return queueTerminalSessionOperation(terminalId, async () => {
    const sessionDir = getTerminalSessionDir(terminalId, codexHome);
    const blocksDir = getTerminalSessionBlocksDir(terminalId, codexHome);
    await mkdir(sessionDir, { recursive: true });
    await mkdir(blocksDir, { recursive: true });

    const manifest = await readManifest(terminalId, codexHome);
    const existingIndex = manifest.entries.findIndex(
      (entry) =>
        entry.reference.sessionId === sessionId &&
        entry.reference.messageKey === messageKey,
    );
    const existing = existingIndex >= 0 ? manifest.entries[existingIndex] : null;
    const entryId = existing?.entryId ?? generateEntryId();
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const updatedAt = new Date().toISOString();
    const transcriptPath = join(
      TERMINAL_SESSION_BLOCKS_DIRNAME,
      `${entryId}.txt`,
    );
    const entry: TerminalSessionArtifactEntry = {
      entryId,
      terminalId,
      type: "frozen-block",
      createdAt,
      updatedAt,
      stepId,
      transcriptPath,
      transcriptLength: transcript.length,
      reference: {
        kind: "codex-session-message",
        sessionId,
        messageKey,
      },
    };

    await writeTextFileAtomic(join(sessionDir, transcriptPath), transcript);

    const nextEntries = [...manifest.entries];
    if (existingIndex >= 0) {
      nextEntries[existingIndex] = entry;
    } else {
      nextEntries.push(entry);
    }

    await writeTextFileAtomic(
      getTerminalSessionManifestPath(terminalId, codexHome),
      JSON.stringify(
        {
          terminalId,
          createdAt: manifest.createdAt,
          updatedAt,
          blocks: nextEntries.flatMap((nextEntry) => {
            const messageBlockId = getMessageBlockId(nextEntry.entryId);
            return [
              {
                blockId: messageBlockId,
                type: "codex-session-message",
                createdAt: nextEntry.createdAt,
                updatedAt: nextEntry.updatedAt,
                sessionId: nextEntry.reference.sessionId,
                messageKey: nextEntry.reference.messageKey,
              } satisfies PersistedCodexSessionMessageBlockRecord,
              {
                blockId: nextEntry.entryId,
                type: "terminal-frozen-output",
                createdAt: nextEntry.createdAt,
                updatedAt: nextEntry.updatedAt,
                path: nextEntry.transcriptPath,
                transcriptLength: nextEntry.transcriptLength,
                stepId: nextEntry.stepId,
                source: {
                  kind: "codex-session-message",
                  blockId: messageBlockId,
                },
              } satisfies PersistedTerminalFrozenOutputBlockRecord,
            ] satisfies PersistedTerminalSessionBlockRecord[];
          }),
        },
        null,
        2,
      ),
    );

    return { entry };
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
  const filteredEntries = manifest.entries.filter((entry) =>
    sessionId ? entry.reference.sessionId === sessionId : true,
  );

  const entriesWithTranscript: TerminalSessionArtifactEntryWithTranscript[] = [];
  const frozenOutputByMessageKey: Record<string, string> = {};
  const frozenOutputsInOrder: string[] = [];

  for (const entry of filteredEntries) {
    try {
      const transcript = await readFile(
        join(
          getTerminalSessionDir(normalizedTerminalId, codexHome),
          entry.transcriptPath,
        ),
        "utf-8",
      );
      entriesWithTranscript.push({
        ...entry,
        transcript,
      });
      frozenOutputByMessageKey[entry.reference.messageKey] = transcript;
      frozenOutputsInOrder.push(transcript);
    } catch {
      // Ignore missing block payloads and continue restoring remaining entries.
    }
  }

  return {
    terminalId: normalizedTerminalId,
    sessionId,
    manifest,
    entries: entriesWithTranscript,
    frozenOutputByMessageKey,
    frozenOutputsInOrder,
  };
}

export async function removeTerminalSessionArtifacts(
  terminalId: string,
  codexHome?: string | null,
): Promise<void> {
  const normalizedTerminalId = terminalId.trim();
  if (!normalizedTerminalId) {
    return;
  }

  await queueTerminalSessionOperation(normalizedTerminalId, async () => {
    await rm(getTerminalSessionDir(normalizedTerminalId, codexHome), {
      recursive: true,
      force: true,
    });
  });
}

export function removeTerminalSessionArtifactsSync(
  terminalId: string,
  codexHome?: string | null,
): void {
  const normalizedTerminalId = terminalId.trim();
  if (!normalizedTerminalId) {
    return;
  }

  const sessionDir = getTerminalSessionDir(normalizedTerminalId, codexHome);
  if (!existsSync(sessionDir)) {
    return;
  }
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // Ignore best-effort cleanup failures.
  }
}

export function readPersistedTerminalSessionManifestSync(
  terminalId: string,
  codexHome?: string | null,
): TerminalSessionArtifactsManifest {
  const normalizedTerminalId = terminalId.trim();
  if (!normalizedTerminalId) {
    throw new Error("terminalId is required");
  }

  try {
    const manifestText = readFileSync(
      getTerminalSessionManifestPath(normalizedTerminalId, codexHome),
      "utf-8",
    );
    return normalizeTerminalSessionManifest(
      JSON.parse(manifestText),
      normalizedTerminalId,
    );
  } catch {
    return {
      terminalId: normalizedTerminalId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entries: [],
    };
  }
}
