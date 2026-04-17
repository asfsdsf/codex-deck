import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { getCodexDir } from "./storage";
import type {
  TerminalPersistFrozenBlockRequest,
  TerminalPersistFrozenBlockResponse,
  TerminalPersistMessageActionRequest,
  TerminalPersistMessageActionResponse,
  TerminalSessionArtifactEntry,
  TerminalSessionArtifactEntryWithTranscript,
  TerminalSessionArtifactsManifest,
  TerminalSessionArtifactsResponse,
  TerminalSessionMessageAction,
  TerminalSessionMessageActionDecision,
  TerminalSessionMessageActionStep,
} from "./storage";

/**
 * Handles persistence for terminal-session artifacts under the codex home
 * directory.
 *
 * Storage layout:
 * - `session.json` stores the logical manifest for one terminal session
 * - `blocks/<entryId>.txt` stores the raw frozen terminal transcript for one
 *   frozen block
 *
 * High-level terminal session save process:
 * 1. The UI or API asks to persist either:
 *    - a frozen terminal transcript tied to a Codex message, or
 *    - a frozen terminal transcript manually anchored before a message, or
 *    - a step approval/rejection action tied to a Codex message
 * 2. The request is normalized and validated so the rest of the module works
 *    with one strict internal shape instead of raw request payloads.
 * 3. The write is queued per terminal id. This prevents two concurrent save
 *    operations for the same terminal from interleaving and corrupting the
 *    manifest order.
 * 4. The current manifest is loaded from disk. If it is missing, empty, or
 *    legacy-shaped, it is normalized into the current internal representation.
 * 5. Existing related blocks are located:
 *    - the message block for the Codex message, if one exists
 *    - the frozen block for the same message or inline anchor, if one exists
 * 6. Stable ids and timestamps are chosen. Existing blocks reuse their ids and
 *    original `createdAt` values so updates replace old state instead of
 *    creating duplicates.
 * 7. For frozen output saves, the transcript text is written first to
 *    `blocks/<entryId>.txt` using an atomic write-then-rename sequence.
 * 8. The in-memory block list is updated:
 *    - message blocks hold message identity plus step-action state
 *    - frozen-output blocks hold transcript metadata plus a reference back to
 *      the message block or inline-output anchor
 * 9. The manifest is rewritten atomically. This is the logical commit point for
 *    the save operation.
 * 10. Later restore calls read the manifest, hydrate transcript payloads from
 *     `blocks/*.txt`, and return the public artifact view used by the UI.
 *
 * Design notes:
 * - Transcript payloads are stored separately from the manifest so large
 *   terminal output does not bloat `session.json`.
 * - Step actions live on message blocks instead of frozen-output blocks so one
 *   message can accumulate approval state independent of transcript snapshots.
 * - Legacy manifest layouts are still accepted and upgraded on read so old
 *   terminal sessions remain visible after refactors.
 * - Malformed individual blocks are skipped during restore when possible so one
 *   bad record does not hide the entire terminal session.
 */
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
  action: TerminalSessionMessageAction | null;
}

interface PersistedTerminalFrozenOutputBlockRecord {
  blockId: string;
  type: "terminal-frozen-output";
  createdAt: string;
  updatedAt: string;
  path: string;
  transcriptLength: number;
  stepId: string | null;
  source:
    | {
        kind: "codex-session-message";
        blockId: string;
      }
    | {
        kind: "terminal-inline-output";
        sessionId: string;
        beforeMessageKey: string;
      };
}

type PersistedTerminalSessionBlockRecord =
  | PersistedCodexSessionMessageBlockRecord
  | PersistedTerminalFrozenOutputBlockRecord;

interface PersistedTerminalSessionBlocksManifest {
  terminalId: string;
  createdAt: string;
  updatedAt: string;
  blocks: PersistedTerminalSessionBlockRecord[];
}

interface NormalizedPersistFrozenBlockInput {
  terminalId: string;
  sessionId: string;
  transcript: string;
  stepId: string | null;
  reference:
    | {
        kind: "codex-session-message";
        messageKey: string;
      }
    | {
        kind: "terminal-inline-output";
        beforeMessageKey: string;
      };
}

interface NormalizedPersistMessageActionInput {
  terminalId: string;
  sessionId: string;
  messageKey: string;
  stepId: string;
  decision: TerminalSessionMessageActionDecision;
  reason: string | null;
}

interface ExistingFrozenBlockContext {
  messageBlockIndex: number;
  messageBlock: PersistedCodexSessionMessageBlockRecord | null;
  frozenBlockIndex: number;
  frozenBlock: PersistedTerminalFrozenOutputBlockRecord | null;
}

// Basic runtime coercion helpers. The manifest comes from disk, so every read
// starts from `unknown` and narrows aggressively before the rest of the module
// can trust any field.
function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asString(value: unknown): string | null {
  // Empty strings are treated the same as missing data throughout this module.
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeTerminalSessionMessageActionDecision(
  value: unknown,
): TerminalSessionMessageActionDecision | null {
  // Persisted decisions are a tiny enum; anything else is discarded.
  return value === "approved" || value === "rejected" ? value : null;
}

function normalizeTerminalSessionMessageActionStep(
  value: unknown,
): TerminalSessionMessageActionStep | null {
  const record = asRecord(value);
  const stepId = asString(record.stepId);
  const decision = normalizeTerminalSessionMessageActionDecision(
    record.decision,
  );
  const updatedAt = asString(record.updatedAt);

  if (!stepId || !decision || !updatedAt) {
    return null;
  }

  return {
    stepId,
    decision,
    // `reason` is intentionally nullable so a clean approval can omit text.
    reason: record.reason === null ? null : asString(record.reason),
    updatedAt,
  };
}

function normalizeTerminalSessionMessageAction(
  value: unknown,
): TerminalSessionMessageAction | null {
  const record = asRecord(value);
  const kind = asString(record.kind);
  if (kind !== "ai-terminal-step-actions" || !Array.isArray(record.steps)) {
    return null;
  }

  const steps = record.steps
    // Drop malformed individual steps rather than discarding the whole action.
    .map((step) => normalizeTerminalSessionMessageActionStep(step))
    .filter((step): step is TerminalSessionMessageActionStep => step !== null);

  return steps.length > 0
    ? {
        kind: "ai-terminal-step-actions",
        steps,
      }
    : null;
}

// Path helpers keep every caller pointing at the same on-disk layout so the
// read, write, and cleanup code never drift apart.
function resolveCodexHome(codexHome?: string | null): string {
  const normalized = codexHome?.trim();
  if (normalized) {
    // Tests and callers can override the codex home explicitly.
    return normalized;
  }

  const current = getCodexDir()?.trim();
  if (current) {
    // Respect the app-level configured codex directory when present.
    return current;
  }

  // Final fallback matches the default Codex CLI home directory.
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
  const beforeMessageKey = asString(reference.beforeMessageKey);
  const stepId =
    record.stepId === null ? null : (asString(record.stepId) ?? null);

  if (
    !entryId ||
    !terminalId ||
    type !== "frozen-block" ||
    !createdAt ||
    !updatedAt ||
    !transcriptPath ||
    transcriptLength === null ||
    !sessionId
  ) {
    // Public artifact entries must be complete because restore callers consume
    // them directly without any additional validation layer.
    return null;
  }

  // Persisted entries can point either at a Codex completion message or at a
  // piece of terminal output manually anchored before a message. Normalize both
  // variants into the public union type used by callers.
  let normalizedReference: TerminalSessionArtifactEntry["reference"] | null =
    null;
  if (referenceKind === "codex-session-message" && messageKey) {
    normalizedReference = {
      kind: "codex-session-message",
      sessionId,
      messageKey,
    };
  } else if (referenceKind === "terminal-inline-output" && beforeMessageKey) {
    normalizedReference = {
      kind: "terminal-inline-output",
      sessionId,
      beforeMessageKey,
    };
  }

  if (!normalizedReference) {
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
    reference: normalizedReference,
  };
}

function normalizeTerminalSessionManifest(
  value: unknown,
  terminalId: string,
): TerminalSessionArtifactsManifest {
  const record = asRecord(value);
  const createdAt = asString(record.createdAt) ?? new Date().toISOString();
  const updatedAt = asString(record.updatedAt) ?? createdAt;
  // Old manifests stored their interesting data under `blocks`, and the modern
  // public shape still derives entries from that list.
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
  const action = normalizeTerminalSessionMessageAction(record.action);

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
    action,
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
  const stepId =
    record.stepId === null ? null : (asString(record.stepId) ?? null);
  const source = asRecord(record.source);
  const sourceKind = asString(source.kind);
  const sourceBlockId = asString(source.blockId);
  const sourceSessionId = asString(source.sessionId);
  const sourceBeforeMessageKey = asString(source.beforeMessageKey);

  if (
    !blockId ||
    type !== "terminal-frozen-output" ||
    !createdAt ||
    !updatedAt ||
    !path ||
    transcriptLength === null
  ) {
    return null;
  }

  // Frozen-output blocks store only a source pointer, so restore has to resolve
  // that pointer back into either a message block or a manual inline anchor.
  let normalizedSource:
    | PersistedTerminalFrozenOutputBlockRecord["source"]
    | null = null;
  if (sourceKind === "codex-session-message" && sourceBlockId) {
    normalizedSource = {
      kind: "codex-session-message",
      blockId: sourceBlockId,
    };
  } else if (
    sourceKind === "terminal-inline-output" &&
    sourceSessionId &&
    sourceBeforeMessageKey
  ) {
    normalizedSource = {
      kind: "terminal-inline-output",
      sessionId: sourceSessionId,
      beforeMessageKey: sourceBeforeMessageKey,
    };
  }

  if (!normalizedSource) {
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
    source: normalizedSource,
  };
}

/**
 * Converts one legacy combined manifest block into the modern public artifact
 * entry shape.
 *
 * Steps:
 * 1. Read the old combined block fields from raw JSON.
 * 2. Validate the legacy `reference` and `frozenArtifact` payloads.
 * 3. Translate the record into the current `frozen-block` artifact entry.
 * 4. Return `null` for malformed legacy data so restore can continue.
 */
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
      : (asString(frozenArtifact.stepId) ?? null);

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
    // Legacy migration is best-effort. One bad old record should not prevent
    // other blocks from being upgraded and restored.
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

/**
 * Converts the persisted block list into the public artifact-entry list used by
 * restore callers.
 *
 * Steps:
 * 1. Build a lookup table of message blocks by block id.
 * 2. Iterate through persisted blocks in original order.
 * 3. Convert legacy combined entries first when present.
 * 4. Resolve modern frozen-output blocks back to either a codex message
 *    reference or an inline-output anchor.
 * 5. Skip malformed blocks so partial recovery still works.
 */
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
      // Frozen-output blocks refer to message blocks only by block id, so we
      // build this lookup up front before restoring entries.
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
      // Legacy combined records already contain both sides of the relationship,
      // so they can be emitted directly as one modern artifact entry.
      entries.push(normalizedLegacyEntry);
      continue;
    }

    const frozenBlock = normalizeTerminalFrozenOutputBlockRecord(block);
    if (!frozenBlock) {
      continue;
    }

    const reference =
      frozenBlock.source.kind === "codex-session-message"
        ? (() => {
            const messageBlock = messageBlocks.get(frozenBlock.source.blockId);
            if (!messageBlock) {
              // A dangling frozen block is ignored rather than throwing so the
              // rest of the manifest can still be restored.
              return null;
            }
            return {
              kind: "codex-session-message" as const,
              sessionId: messageBlock.sessionId,
              messageKey: messageBlock.messageKey,
            };
          })()
        : {
            kind: "terminal-inline-output" as const,
            sessionId: frozenBlock.source.sessionId,
            beforeMessageKey: frozenBlock.source.beforeMessageKey,
          };
    if (!reference) {
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
      reference,
    });
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

function getMessageBlockId(entryId: string): string {
  // Message blocks are deterministically tied to the frozen block entry id.
  return `${entryId}-message`;
}

function legacyEntryToPersistedBlocks(
  entry: TerminalSessionArtifactEntry,
): PersistedTerminalSessionBlockRecord[] {
  if (entry.reference.kind !== "codex-session-message") {
    // Inline-output anchors never had a standalone message block, so the modern
    // representation is still just one frozen-output block.
    return [
      {
        blockId: entry.entryId,
        type: "terminal-frozen-output",
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        path: entry.transcriptPath,
        transcriptLength: entry.transcriptLength,
        stepId: entry.stepId,
        source: {
          kind: "terminal-inline-output",
          sessionId: entry.reference.sessionId,
          beforeMessageKey: entry.reference.beforeMessageKey,
        },
      },
    ];
  }

  const messageBlockId = getMessageBlockId(entry.entryId);
  return [
    // Modern manifests separate the logical message reference from the frozen
    // transcript payload so actions can live on the message block.
    {
      blockId: messageBlockId,
      type: "codex-session-message",
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      sessionId: entry.reference.sessionId,
      messageKey: entry.reference.messageKey,
      action: null,
    },
    {
      blockId: entry.entryId,
      type: "terminal-frozen-output",
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      path: entry.transcriptPath,
      transcriptLength: entry.transcriptLength,
      stepId: entry.stepId,
      source: {
        kind: "codex-session-message",
        blockId: messageBlockId,
      },
    },
  ];
}

/**
 * Normalizes the on-disk manifest into the current split-block representation.
 *
 * Steps:
 * 1. Read manifest timestamps with safe fallbacks.
 * 2. Walk the persisted block array in order.
 * 3. Keep already-modern message and frozen-output blocks after validation.
 * 4. Upgrade legacy combined entries into separate message/frozen blocks.
 * 5. Return one canonical manifest shape for the rest of the module.
 */
function normalizePersistedTerminalSessionBlocksManifest(
  value: unknown,
  terminalId: string,
): PersistedTerminalSessionBlocksManifest {
  const record = asRecord(value);
  const createdAt = asString(record.createdAt) ?? new Date().toISOString();
  const updatedAt = asString(record.updatedAt) ?? createdAt;
  const blocks: PersistedTerminalSessionBlockRecord[] = [];

  for (const block of Array.isArray(record.blocks) ? record.blocks : []) {
    const messageBlock = normalizeCodexSessionMessageBlockRecord(block);
    if (messageBlock) {
      // Already-modern message blocks pass straight through.
      blocks.push(messageBlock);
      continue;
    }

    const frozenBlock = normalizeTerminalFrozenOutputBlockRecord(block);
    if (frozenBlock) {
      // Already-modern frozen blocks also pass straight through.
      blocks.push(frozenBlock);
      continue;
    }

    const legacyEntry = normalizeLegacyCombinedBlockRecordToArtifactEntry(
      block,
      terminalId,
    );
    if (legacyEntry) {
      // Legacy records are upgraded eagerly so later code only handles one
      // canonical block representation.
      blocks.push(...legacyEntryToPersistedBlocks(legacyEntry));
    }
  }

  return {
    terminalId,
    createdAt,
    updatedAt,
    blocks,
  };
}

function toTerminalSessionArtifactsManifest(
  manifest: PersistedTerminalSessionBlocksManifest,
): TerminalSessionArtifactsManifest {
  return {
    terminalId: manifest.terminalId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    // The public manifest intentionally hides the internal split-block detail.
    entries: normalizePersistedBlocksToArtifactEntries(
      manifest.blocks,
      manifest.terminalId,
    ),
  };
}

function serializePersistedBlock(
  block: PersistedTerminalSessionBlockRecord,
): PersistedTerminalSessionBlockRecord {
  if (block.type !== "codex-session-message") {
    return block;
  }

  return {
    ...block,
    // Keep `action: null` explicit so round-trips do not oscillate between
    // missing and null fields on disk.
    action: block.action ?? null,
  };
}

async function writeBlocksManifest(
  terminalId: string,
  manifest: PersistedTerminalSessionBlocksManifest,
  blocks: PersistedTerminalSessionBlockRecord[],
  updatedAt: string,
  codexHome?: string | null,
): Promise<void> {
  await writeTextFileAtomic(
    getTerminalSessionManifestPath(terminalId, codexHome),
    JSON.stringify(
      {
        terminalId,
        createdAt: manifest.createdAt,
        updatedAt,
        // Serialize blocks through one helper so nullable action payloads stay
        // explicit on disk instead of disappearing via JSON omission.
        blocks: blocks.map((block) => serializePersistedBlock(block)),
      },
      null,
      2,
    ),
  );
}

function createEmptyBlocksManifest(
  terminalId: string,
  timestamp = new Date().toISOString(),
): PersistedTerminalSessionBlocksManifest {
  return {
    terminalId,
    createdAt: timestamp,
    updatedAt: timestamp,
    // An absent manifest and an empty manifest are treated the same by callers.
    blocks: [],
  };
}

function findCodexSessionMessageBlockIndex(
  blocks: PersistedTerminalSessionBlockRecord[],
  sessionId: string,
  messageKey: string,
): number {
  // Message identity is scoped by both session id and message key.
  return blocks.findIndex(
    (block) =>
      block.type === "codex-session-message" &&
      block.sessionId === sessionId &&
      block.messageKey === messageKey,
  );
}

function findFrozenBlockIndexForMessageBlock(
  blocks: PersistedTerminalSessionBlockRecord[],
  messageBlockId: string,
): number {
  // Message-backed frozen blocks do not repeat session/message ids; they point
  // to the message block instead.
  return blocks.findIndex(
    (block) =>
      block.type === "terminal-frozen-output" &&
      block.source.kind === "codex-session-message" &&
      block.source.blockId === messageBlockId,
  );
}

function findManualFrozenBlockIndex(
  blocks: PersistedTerminalSessionBlockRecord[],
  sessionId: string,
  beforeMessageKey: string,
): number {
  // Inline-output anchors are identified by the session plus the message they
  // are inserted before.
  return blocks.findIndex(
    (block) =>
      block.type === "terminal-frozen-output" &&
      block.source.kind === "terminal-inline-output" &&
      block.source.sessionId === sessionId &&
      block.source.beforeMessageKey === beforeMessageKey,
  );
}

async function writeTextFileAtomic(path: string, text: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  // Write-then-rename avoids partially written files if the process exits in
  // the middle of a persistence update.
  await writeFile(tempPath, text, "utf-8");
  await rename(tempPath, path);
}

const terminalSessionOperationQueues = new Map<string, Promise<void>>();

/**
 * Serializes async operations for a single terminal.
 *
 * Steps:
 * 1. Read the previously queued promise for this terminal, if any.
 * 2. Chain the next operation after it, while swallowing prior failures so the
 *    queue keeps moving.
 * 3. Store the cleanup promise back into the queue map.
 * 4. Remove the queue entry when the latest scheduled operation settles.
 */
function queueTerminalSessionOperation<T>(
  terminalId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous =
    terminalSessionOperationQueues.get(terminalId) ?? Promise.resolve();
  // A failed prior write should not poison the queue forever, so the chain
  // deliberately continues after rejections.
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
  // This is the async "public manifest" read path used by restore callers.
  return toTerminalSessionArtifactsManifest(
    await readBlocksManifest(terminalId, codexHome),
  );
}

/**
 * Reads the raw on-disk manifest and normalizes it into the internal
 * block-based structure.
 *
 * Steps:
 * 1. Read `session.json` from the terminal session directory.
 * 2. Parse the JSON payload.
 * 3. Normalize modern and legacy data into the same internal manifest shape.
 * 4. Fall back to an empty manifest when the file is absent or unreadable.
 */
async function readBlocksManifest(
  terminalId: string,
  codexHome?: string | null,
): Promise<PersistedTerminalSessionBlocksManifest> {
  try {
    const manifestText = await readFile(
      getTerminalSessionManifestPath(terminalId, codexHome),
      "utf-8",
    );
    return normalizePersistedTerminalSessionBlocksManifest(
      JSON.parse(manifestText),
      terminalId,
    );
  } catch {
    return createEmptyBlocksManifest(terminalId);
  }
}

function generateEntryId(): string {
  return `block-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Validates and normalizes a frozen-block persistence request.
 *
 * Steps:
 * 1. Trim all incoming identifiers.
 * 2. Enforce required fields and the mutually-exclusive
 *    `messageKey`/`beforeMessageKey` rules.
 * 3. Normalize optional fields such as `stepId`.
 * 4. Convert the request into a single discriminated `reference` shape.
 */
function normalizePersistFrozenBlockInput(
  input: {
    terminalId: string;
  } & TerminalPersistFrozenBlockRequest,
): NormalizedPersistFrozenBlockInput {
  const terminalId = input.terminalId.trim();
  const sessionId = input.sessionId.trim();
  const messageKey = input.messageKey?.trim() || null;
  const beforeMessageKey = input.beforeMessageKey?.trim() || null;
  const transcript = input.transcript;
  const stepId = input.stepId?.trim() || null;

  if (!terminalId) {
    throw new Error("terminalId is required");
  }
  if (!sessionId) {
    throw new Error("sessionId is required");
  }
  if (!messageKey && !beforeMessageKey) {
    throw new Error("messageKey or beforeMessageKey is required");
  }
  if (messageKey && beforeMessageKey) {
    throw new Error("messageKey and beforeMessageKey cannot both be set");
  }
  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new Error("transcript must be a non-empty string");
  }

  return {
    terminalId,
    sessionId,
    transcript,
    stepId,
    reference:
      messageKey !== null
        ? {
            kind: "codex-session-message",
            messageKey,
          }
        : {
            kind: "terminal-inline-output",
            beforeMessageKey: beforeMessageKey!,
          },
  };
}

/**
 * Validates and normalizes a message-action persistence request.
 *
 * Steps:
 * 1. Trim all incoming identifiers.
 * 2. Validate the required message-action fields.
 * 3. Ensure the decision is one of the supported enum values.
 * 4. Return the internal normalized shape used by the write pipeline.
 */
function normalizePersistMessageActionInput(
  input: {
    terminalId: string;
  } & TerminalPersistMessageActionRequest,
): NormalizedPersistMessageActionInput {
  const terminalId = input.terminalId.trim();
  const sessionId = input.sessionId.trim();
  const messageKey = input.messageKey.trim();
  const stepId = input.stepId.trim();
  const decision = input.decision;
  const reason = input.reason?.trim() || null;

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
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error("decision must be approved or rejected");
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

async function ensureTerminalSessionDir(
  terminalId: string,
  codexHome?: string | null,
): Promise<string> {
  const sessionDir = getTerminalSessionDir(terminalId, codexHome);
  // Creating the directory unconditionally keeps write callers simple.
  await mkdir(sessionDir, { recursive: true });
  return sessionDir;
}

async function ensureTerminalSessionDirs(
  terminalId: string,
  codexHome?: string | null,
): Promise<{
  sessionDir: string;
  blocksDir: string;
}> {
  const sessionDir = await ensureTerminalSessionDir(terminalId, codexHome);
  const blocksDir = getTerminalSessionBlocksDir(terminalId, codexHome);
  await mkdir(blocksDir, { recursive: true });
  // Returning both paths keeps callers from recomputing them and makes it clear
  // that the directory contract for a write is "manifest dir + blocks dir".
  return { sessionDir, blocksDir };
}

/**
 * Locates the manifest blocks that an incoming frozen-block write may update.
 *
 * Steps:
 * 1. Find the message block when the request points at a codex message.
 * 2. Find the related frozen block, either by message-block id or by
 *    `beforeMessageKey` for inline-output anchors.
 * 3. Narrow both results to validated internal record types.
 * 4. Return indexes plus normalized records so callers can upsert safely.
 */
function getExistingFrozenBlockContext(
  manifest: PersistedTerminalSessionBlocksManifest,
  input: NormalizedPersistFrozenBlockInput,
): ExistingFrozenBlockContext {
  const messageBlockIndex =
    input.reference.kind === "codex-session-message"
      ? findCodexSessionMessageBlockIndex(
          manifest.blocks,
          input.sessionId,
          input.reference.messageKey,
        )
      : -1;
  const existingMessageBlock =
    messageBlockIndex >= 0 ? manifest.blocks[messageBlockIndex] : null;
  const messageBlock =
    existingMessageBlock?.type === "codex-session-message"
      ? existingMessageBlock
      : null;

  // The frozen-block lookup depends on which kind of reference the caller is
  // writing: message-backed or inline-output-backed.
  const frozenBlockIndex =
    input.reference.kind === "codex-session-message" && messageBlock
      ? findFrozenBlockIndexForMessageBlock(
          manifest.blocks,
          messageBlock.blockId,
        )
      : input.reference.kind === "terminal-inline-output"
        ? findManualFrozenBlockIndex(
            manifest.blocks,
            input.sessionId,
            input.reference.beforeMessageKey,
          )
        : -1;
  const existingFrozenBlock =
    frozenBlockIndex >= 0 ? manifest.blocks[frozenBlockIndex] : null;
  const frozenBlock =
    existingFrozenBlock?.type === "terminal-frozen-output"
      ? existingFrozenBlock
      : null;

  return {
    messageBlockIndex,
    messageBlock,
    frozenBlockIndex,
    frozenBlock,
  };
}

function createTerminalSessionArtifactEntry(
  input: NormalizedPersistFrozenBlockInput,
  entryId: string,
  createdAt: string,
  updatedAt: string,
): TerminalSessionArtifactEntry {
  return {
    entryId,
    terminalId: input.terminalId,
    type: "frozen-block",
    createdAt,
    updatedAt,
    stepId: input.stepId,
    // Transcript payloads live in separate text files, so the manifest stores a
    // relative path rather than embedding large output blobs.
    transcriptPath: join(TERMINAL_SESSION_BLOCKS_DIRNAME, `${entryId}.txt`),
    transcriptLength: input.transcript.length,
    reference:
      input.reference.kind === "codex-session-message"
        ? {
            kind: "codex-session-message",
            sessionId: input.sessionId,
            messageKey: input.reference.messageKey,
          }
        : {
            kind: "terminal-inline-output",
            sessionId: input.sessionId,
            beforeMessageKey: input.reference.beforeMessageKey,
          },
  };
}

function createMessageBlock(
  input: Pick<NormalizedPersistFrozenBlockInput, "sessionId" | "reference">,
  messageBlockId: string,
  createdAt: string,
  updatedAt: string,
  action: TerminalSessionMessageAction | null,
): PersistedCodexSessionMessageBlockRecord {
  if (input.reference.kind !== "codex-session-message") {
    throw new Error("message blocks require a codex-session-message reference");
  }

  return {
    blockId: messageBlockId,
    type: "codex-session-message",
    createdAt,
    updatedAt,
    sessionId: input.sessionId,
    messageKey: input.reference.messageKey,
    // Step-approval state lives on the message block, not on the transcript
    // block, so the same message can accumulate decisions over time.
    action,
  };
}

function createFrozenOutputBlock(
  input: NormalizedPersistFrozenBlockInput,
  entry: TerminalSessionArtifactEntry,
  createdAt: string,
  messageBlockId: string | null,
): PersistedTerminalFrozenOutputBlockRecord {
  return {
    blockId: entry.entryId,
    type: "terminal-frozen-output",
    createdAt,
    updatedAt: entry.updatedAt,
    path: entry.transcriptPath,
    transcriptLength: entry.transcriptLength,
    stepId: entry.stepId,
    source:
      input.reference.kind === "codex-session-message"
        ? {
            // The frozen block points at the message block instead of repeating
            // session/message ids so actions and transcript snapshots stay
            // loosely coupled.
            kind: "codex-session-message",
            blockId: messageBlockId!,
          }
        : {
            kind: "terminal-inline-output",
            sessionId: input.sessionId,
            beforeMessageKey: input.reference.beforeMessageKey,
          },
  };
}

function upsertBlock(
  blocks: PersistedTerminalSessionBlockRecord[],
  index: number,
  block: PersistedTerminalSessionBlockRecord,
): number {
  if (index >= 0) {
    blocks[index] = block;
    return index;
  }

  // New blocks are appended by default; callers that care about adjacency can
  // place dependent blocks later with an explicit insertion index.
  blocks.push(block);
  return blocks.length - 1;
}

function upsertFrozenBlock(
  blocks: PersistedTerminalSessionBlockRecord[],
  block: PersistedTerminalFrozenOutputBlockRecord,
  existingIndex: number,
  insertionIndex: number,
): void {
  if (existingIndex >= 0) {
    blocks[existingIndex] = block;
    return;
  }

  const blockIndex = blocks.findIndex(
    (candidate) =>
      candidate.type === "terminal-frozen-output" &&
      candidate.blockId === block.blockId,
  );
  if (blockIndex >= 0) {
    // This fallback protects against cases where the caller lost the original
    // index but the entry id still already exists in the manifest.
    blocks[blockIndex] = block;
    return;
  }

  // New frozen blocks are inserted immediately after their message block when
  // possible so manifest order mirrors the UI relationship.
  blocks.splice(insertionIndex, 0, block);
}

function createActionStep(
  input: NormalizedPersistMessageActionInput,
  updatedAt: string,
): TerminalSessionMessageActionStep {
  return {
    stepId: input.stepId,
    decision: input.decision,
    reason: input.reason,
    // Every update gets its own timestamp so later UI reads can show the latest
    // action chronology without diffing manifests.
    updatedAt,
  };
}

function createMessageAction(
  existingMessageBlock: PersistedCodexSessionMessageBlockRecord | null,
  actionStep: TerminalSessionMessageActionStep,
): TerminalSessionMessageAction {
  const existingSteps =
    existingMessageBlock?.action?.steps.filter(
      (step) => step.stepId !== actionStep.stepId,
    ) ?? [];

  return {
    kind: "ai-terminal-step-actions",
    // Replacing by `stepId` keeps the latest decision authoritative while
    // preserving the rest of the step history for the same message.
    steps: [...existingSteps, actionStep],
  };
}

async function readEntryTranscript(
  terminalId: string,
  transcriptPath: string,
  codexHome?: string | null,
): Promise<string | null> {
  try {
    // Transcript files are stored relative to the terminal session directory.
    return await readFile(
      join(getTerminalSessionDir(terminalId, codexHome), transcriptPath),
      "utf-8",
    );
  } catch {
    // Restore callers treat missing payloads as partial data, not fatal errors.
    return null;
  }
}

/**
 * Persists a frozen terminal transcript and updates the session manifest.
 *
 * Steps:
 * 1. Normalize and validate the request.
 * 2. Serialize the write through the per-terminal queue.
 * 3. Ensure the session directories exist.
 * 4. Load the current manifest and inspect any existing related blocks.
 * 5. Reuse stable ids/timestamps when updating an existing frozen block.
 * 6. Write the transcript payload to `blocks/<entryId>.txt`.
 * 7. Upsert the related message block when the frozen output belongs to a
 *    codex session message.
 * 8. Upsert the frozen-output block in manifest order.
 * 9. Atomically rewrite the manifest and return the public artifact entry.
 */
export async function persistTerminalSessionFrozenBlock(
  input: {
    terminalId: string;
  } & TerminalPersistFrozenBlockRequest,
  codexHome?: string | null,
): Promise<TerminalPersistFrozenBlockResponse> {
  const normalizedInput = normalizePersistFrozenBlockInput(input);

  return queueTerminalSessionOperation(normalizedInput.terminalId, async () => {
    const { sessionDir } = await ensureTerminalSessionDirs(
      normalizedInput.terminalId,
      codexHome,
    );

    const manifest = await readBlocksManifest(
      normalizedInput.terminalId,
      codexHome,
    );
    const existingContext = getExistingFrozenBlockContext(
      manifest,
      normalizedInput,
    );
    // Reuse the existing frozen block id when overwriting so references remain
    // stable and callers do not accumulate duplicates for the same anchor.
    const entryId = existingContext.frozenBlock?.blockId ?? generateEntryId();
    const updatedAt = new Date().toISOString();
    const createdAt =
      existingContext.frozenBlock?.createdAt ??
      existingContext.messageBlock?.createdAt ??
      updatedAt;
    const entry = createTerminalSessionArtifactEntry(
      normalizedInput,
      entryId,
      createdAt,
      updatedAt,
    );
    const messageBlockId =
      normalizedInput.reference.kind === "codex-session-message"
        ? (existingContext.messageBlock?.blockId ?? getMessageBlockId(entryId))
        : null;

    // Persist the transcript before rewriting the manifest so the manifest never
    // points at a block path that has not been written yet.
    await writeTextFileAtomic(
      join(sessionDir, entry.transcriptPath),
      normalizedInput.transcript,
    );

    const frozenBlock = createFrozenOutputBlock(
      normalizedInput,
      entry,
      existingContext.frozenBlock?.createdAt ?? createdAt,
      messageBlockId,
    );

    const nextBlocks = [...manifest.blocks];
    let nextMessageBlockIndex = existingContext.messageBlockIndex;
    if (
      normalizedInput.reference.kind === "codex-session-message" &&
      messageBlockId
    ) {
      nextMessageBlockIndex = upsertBlock(
        nextBlocks,
        existingContext.messageBlockIndex,
        createMessageBlock(
          normalizedInput,
          messageBlockId,
          existingContext.messageBlock?.createdAt ?? createdAt,
          updatedAt,
          existingContext.messageBlock?.action ?? null,
        ),
      );
    }

    upsertFrozenBlock(
      nextBlocks,
      frozenBlock,
      existingContext.frozenBlockIndex,
      normalizedInput.reference.kind === "codex-session-message" &&
        nextMessageBlockIndex >= 0
        ? nextMessageBlockIndex + 1
        : nextBlocks.length,
    );

    // Manifest write is the logical commit point for the operation.
    await writeBlocksManifest(
      normalizedInput.terminalId,
      manifest,
      nextBlocks,
      updatedAt,
      codexHome,
    );

    return { entry };
  });
}

/**
 * Persists an approval/rejection action onto a codex-session message block.
 *
 * Steps:
 * 1. Normalize and validate the request.
 * 2. Serialize the write through the per-terminal queue.
 * 3. Ensure the session directory exists so the manifest can be created if
 *    needed.
 * 4. Load the current manifest and locate the target message block.
 * 5. Build the next action step and replace any prior step with the same
 *    `stepId`.
 * 6. Upsert the message block with the merged action state.
 * 7. Atomically rewrite the manifest and return the updated action payload.
 */
export async function persistTerminalSessionMessageAction(
  input: {
    terminalId: string;
  } & TerminalPersistMessageActionRequest,
  codexHome?: string | null,
): Promise<TerminalPersistMessageActionResponse> {
  const normalizedInput = normalizePersistMessageActionInput(input);

  return queueTerminalSessionOperation(normalizedInput.terminalId, async () => {
    await ensureTerminalSessionDir(normalizedInput.terminalId, codexHome);

    const manifest = await readBlocksManifest(
      normalizedInput.terminalId,
      codexHome,
    );
    const messageBlockIndex = findCodexSessionMessageBlockIndex(
      manifest.blocks,
      normalizedInput.sessionId,
      normalizedInput.messageKey,
    );
    const existingMessageBlock =
      messageBlockIndex >= 0 ? manifest.blocks[messageBlockIndex] : null;
    const messageBlock =
      existingMessageBlock?.type === "codex-session-message"
        ? existingMessageBlock
        : null;
    const updatedAt = new Date().toISOString();
    const actionStep = createActionStep(normalizedInput, updatedAt);
    const action = createMessageAction(messageBlock, actionStep);
    // Reuse the existing message block id when present so frozen blocks that
    // already point at it remain valid.
    const nextMessageBlock = createMessageBlock(
      {
        sessionId: normalizedInput.sessionId,
        reference: {
          kind: "codex-session-message",
          messageKey: normalizedInput.messageKey,
        },
      },
      messageBlock?.blockId ?? getMessageBlockId(generateEntryId()),
      messageBlock?.createdAt ?? updatedAt,
      updatedAt,
      action,
    );
    const nextBlocks = [...manifest.blocks];

    if (messageBlockIndex >= 0) {
      nextBlocks[messageBlockIndex] = nextMessageBlock;
    } else {
      // Actions are allowed to arrive before any frozen output exists for that
      // message, so we create the message block on demand.
      nextBlocks.push(nextMessageBlock);
    }

    await writeBlocksManifest(
      normalizedInput.terminalId,
      manifest,
      nextBlocks,
      updatedAt,
      codexHome,
    );

    return {
      terminalId: normalizedInput.terminalId,
      sessionId: normalizedInput.sessionId,
      messageKey: normalizedInput.messageKey,
      action,
    };
  });
}

/**
 * Restores persisted terminal-session artifacts, optionally filtered to one
 * codex session id.
 *
 * Steps:
 * 1. Normalize the terminal id and load the manifest.
 * 2. Filter entries by `sessionId` when requested.
 * 3. Read each transcript payload from disk.
 * 4. Skip missing transcript files so one broken entry does not block restore.
 * 5. Build the hydrated entry list plus the lookup maps used by the UI.
 * 6. Return the manifest and all restored transcript views.
 */
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
  // A terminal can contain artifacts for more than one codex session over time,
  // so callers can request a session-scoped slice here.
  const filteredEntries = manifest.entries.filter((entry) =>
    sessionId ? entry.reference.sessionId === sessionId : true,
  );

  const entriesWithTranscript: TerminalSessionArtifactEntryWithTranscript[] =
    [];
  const frozenOutputByMessageKey: Record<string, string> = {};
  const frozenOutputByBeforeMessageKey: Record<string, string> = {};
  const frozenOutputsInOrder: string[] = [];

  for (const entry of filteredEntries) {
    const transcript = await readEntryTranscript(
      normalizedTerminalId,
      entry.transcriptPath,
      codexHome,
    );
    if (transcript === null) {
      // Missing payload files are tolerated so one broken entry does not blank
      // the entire terminal restore state.
      continue;
    }

    entriesWithTranscript.push({
      ...entry,
      transcript,
    });
    if (entry.reference.kind === "codex-session-message") {
      frozenOutputByMessageKey[entry.reference.messageKey] = transcript;
      // Only message-backed frozen outputs participate in ordered restore for
      // terminal completion messages.
      frozenOutputsInOrder.push(transcript);
    } else {
      frozenOutputByBeforeMessageKey[entry.reference.beforeMessageKey] =
        transcript;
    }
  }

  return {
    terminalId: normalizedTerminalId,
    sessionId,
    manifest,
    entries: entriesWithTranscript,
    frozenOutputByMessageKey,
    frozenOutputByBeforeMessageKey,
    frozenOutputsInOrder,
  };
}

/**
 * Removes the persisted artifact directory for a terminal asynchronously.
 *
 * Steps:
 * 1. Normalize the terminal id and exit early for blank input.
 * 2. Serialize deletion through the per-terminal queue.
 * 3. Recursively delete the session directory with force enabled.
 */
export async function removeTerminalSessionArtifacts(
  terminalId: string,
  codexHome?: string | null,
): Promise<void> {
  const normalizedTerminalId = terminalId.trim();
  if (!normalizedTerminalId) {
    return;
  }

  await queueTerminalSessionOperation(normalizedTerminalId, async () => {
    // Force deletion keeps cleanup idempotent if some files were already
    // removed by a prior attempt.
    await rm(getTerminalSessionDir(normalizedTerminalId, codexHome), {
      recursive: true,
      force: true,
    });
  });
}

/**
 * Best-effort synchronous cleanup for terminal artifacts.
 *
 * Steps:
 * 1. Normalize the terminal id and resolve its session directory.
 * 2. Exit early when the directory does not exist.
 * 3. Delete the directory recursively.
 * 4. Ignore failures because this path is used for cleanup, not critical
 *    persistence.
 */
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
    // Missing directories are normal for best-effort cleanup.
    return;
  }
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // Ignore best-effort cleanup failures.
  }
}

/**
 * Reads the persisted manifest synchronously and returns the public artifact
 * view.
 *
 * Steps:
 * 1. Normalize and validate the terminal id.
 * 2. Read and parse `session.json`.
 * 3. Normalize the data so legacy and modern manifests share one output shape.
 * 4. Fall back to an empty manifest when the file is missing or unreadable.
 */
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
    // The sync path returns the public view directly because callers generally
    // use it for simple inspection rather than block-level mutation.
    return normalizeTerminalSessionManifest(
      JSON.parse(manifestText),
      normalizedTerminalId,
    );
  } catch {
    return toTerminalSessionArtifactsManifest(
      createEmptyBlocksManifest(normalizedTerminalId),
    );
  }
}
