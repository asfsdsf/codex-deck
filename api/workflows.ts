import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getCodexDir } from "./storage";
import { isPathWithinDirectory } from "./path-utils";
import type {
  CreateWorkflowRequest,
  WorkflowActionResponse,
  WorkflowBindSessionRequest,
  WorkflowControlMessageRequest,
  WorkflowCreateResponse,
  WorkflowDaemonStatusResponse,
  WorkflowDetailResponse,
  WorkflowHistoryEntry,
  WorkflowLogResponse,
  WorkflowSchedulerState,
  WorkflowRecentOutcome,
  WorkflowSessionLookupResponse,
  WorkflowSessionRoleSummary,
  WorkflowSessionRole,
  WorkflowStatus,
  WorkflowSummary,
  WorkflowTaskCounts,
  WorkflowTaskStatus,
  WorkflowTaskSummary,
} from "./storage";

const WORKFLOW_REGISTRY_DIRNAME = "codex-deck/workflows";
const WORKFLOW_SESSION_INDEX_DIRNAME = "codex-deck/workflows/session-index";
const WORKFLOW_DAEMON_DIRNAME = "codex-deck/workflows/daemon-state";
const RUN_SCRIPT_PATH = resolve(
  process.cwd(),
  ".claude/skills/codex-deck-flow/scripts/run.sh",
);
const DEFAULT_TARGET_BRANCH_FALLBACK = "main";
const DEFAULT_STOP_SIGNAL = "[codex-deck:stop-pending]";
const DEFAULT_WORKFLOW_MERGE_POLICY = "integration-branch";
const DEFAULT_CREATE_SUGGESTION_COUNT = 3;
// Keep this default prompt in sync with skills/codex-deck-flow/scripts/workflow.py.
const DEFAULT_SCHEDULER_PROMPT =
  "You are the runtime scheduler for this workflow. " +
  "Start each turn by refreshing workflow state: reconcile dead runners, apply stop-signal pruning, and recompute workflow status. " +
  "Then inspect status and ready tasks before making scheduling decisions. " +
  "Process any active control messages from the operator before deciding whether to edit workflow state or launch more work. " +
  "Use only the codex-deck-flow command surface provided in this prompt for orchestration. " +
  "Launch tasks only when dependencies are satisfied, branch conflicts are avoided, and workflow capacity allows more running tasks. " +
  "Keep merge explicit; do not merge unless the user explicitly asked. " +
  "Before finishing the turn, run validate and ensure it succeeds.";
const VALID_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  "draft",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
const VALID_WORKFLOW_TASK_STATUSES = new Set<WorkflowTaskStatus>([
  "pending",
  "running",
  "success",
  "failed",
  "cancelled",
]);

type JsonObject = Record<string, unknown>;

interface WorkflowRegistryRecord {
  key?: unknown;
  workflowPath?: unknown;
  workflow?: {
    id?: unknown;
    title?: unknown;
    status?: unknown;
    projectRoot?: unknown;
    targetBranch?: unknown;
    updatedAt?: unknown;
    createdAt?: unknown;
    request?: unknown;
    boundSession?: unknown;
  };
  scheduler?: {
    running?: unknown;
    pendingTrigger?: unknown;
    lastSessionId?: unknown;
    threadId?: unknown;
    lastReason?: unknown;
    lastRunAt?: unknown;
    lastTurnStatus?: unknown;
  };
  settings?: {
    codexHome?: unknown;
    maxParallel?: unknown;
    mergePolicy?: unknown;
  };
  sessionIndex?: unknown;
  taskCounts?: Record<string, unknown>;
  recentOutcomes?: unknown;
}

interface WorkflowSessionIndexRecord {
  sessionId: string;
  type: "bound" | "scheduler" | "task";
  workflowKey: string;
  workflowId: string;
  workflowTitle: string;
  workflowPath: string;
  projectRoot: string;
  taskId: string | null;
  updatedAt: string | null;
}

interface WorkflowSessionIndexSummary {
  sessionId: string;
  type: WorkflowSessionRole;
  taskId: string | null;
}

interface GitCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface WorkflowBackfillOptions {
  required?: boolean;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function isIgnorableWorkflowIndexReadError(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException).code === "ENOENT" ||
    error instanceof SyntaxError
  );
}

function isWorkflowBackendUnavailableError(error: unknown): boolean {
  const errorCode = (error as NodeJS.ErrnoException).code;
  if (
    errorCode === "EACCES" ||
    errorCode === "EFTYPE" ||
    errorCode === "ENOENT" ||
    errorCode === "ENOEXEC"
  ) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    /python was not found/i.test(message) ||
    /python(?:3)?(?:\.exe)?: command not found/i.test(message) ||
    /run\.sh: line \d+: exec: .*: not found/i.test(message) ||
    /'python(?:3)?' is not recognized as an internal or external command/i.test(
      message,
    )
  );
}

function normalizeWorkflowStatus(value: unknown): WorkflowStatus {
  const candidate = asString(value);
  return candidate && VALID_WORKFLOW_STATUSES.has(candidate as WorkflowStatus)
    ? (candidate as WorkflowStatus)
    : "draft";
}

function normalizeTaskStatus(value: unknown): WorkflowTaskStatus {
  const candidate = asString(value);
  return candidate &&
    VALID_WORKFLOW_TASK_STATUSES.has(candidate as WorkflowTaskStatus)
    ? (candidate as WorkflowTaskStatus)
    : "pending";
}

function defaultCodexHome(): string {
  return getCodexDir() || join(homedir(), ".codex");
}

function defaultCodexCliPath(): string {
  return process.env.CODEX_CLI_PATH?.trim() || "codex";
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sanitizeWorkflowId(value: string): string {
  const lowered = value
    .trim()
    .split("")
    .map((char) => (/[A-Za-z0-9]/.test(char) ? char.toLowerCase() : "-"))
    .join("");
  const collapsed = lowered.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return collapsed || `workflow-${Math.floor(Date.now() / 1000)}`;
}

function workflowFile(projectRoot: string, workflowId: string): string {
  return join(projectRoot, ".codex-deck", `${sanitizeWorkflowId(workflowId)}.json`);
}

function workflowRegistryKey(projectRoot: string, workflowId: string): string {
  const normalizedRoot = resolve(projectRoot);
  const digest = createHash("sha1")
    .update(normalizedRoot, "utf-8")
    .digest("hex")
    .slice(0, 12);
  return `${digest}--${sanitizeWorkflowId(workflowId)}`;
}

function getRegistryDir(codexHome?: string | null): string {
  return join(codexHome || defaultCodexHome(), WORKFLOW_REGISTRY_DIRNAME);
}

function getSessionIndexDir(codexHome?: string | null): string {
  return join(codexHome || defaultCodexHome(), WORKFLOW_SESSION_INDEX_DIRNAME);
}

function getDaemonStatePath(codexHome?: string | null): string {
  return join(
    codexHome || defaultCodexHome(),
    WORKFLOW_DAEMON_DIRNAME,
    "state.json",
  );
}

async function readJsonFile(path: string): Promise<JsonObject> {
  const text = await readFile(path, "utf-8");
  const parsed = JSON.parse(text) as unknown;
  return asRecord(parsed);
}

async function readOptionalJsonFile(path: string): Promise<JsonObject | null> {
  try {
    return await readJsonFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeTextFileAtomic(path: string, text: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`,
  );
  try {
    await writeFile(tempPath, text, "utf-8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function normalizeTaskCounts(raw: Record<string, unknown>): WorkflowTaskCounts {
  return {
    total: Math.max(0, Math.floor(asNumber(raw.total) ?? 0)),
    cancelled: Math.max(0, Math.floor(asNumber(raw.cancelled) ?? 0)),
    failed: Math.max(0, Math.floor(asNumber(raw.failed) ?? 0)),
    pending: Math.max(0, Math.floor(asNumber(raw.pending) ?? 0)),
    running: Math.max(0, Math.floor(asNumber(raw.running) ?? 0)),
    success: Math.max(0, Math.floor(asNumber(raw.success) ?? 0)),
  };
}

function normalizeRecentOutcome(value: unknown): WorkflowRecentOutcome | null {
  const record = asRecord(value);
  const taskId = asString(record.taskId);
  if (!taskId) {
    return null;
  }
  return {
    taskId,
    status: normalizeTaskStatus(record.status),
    resultCommit: asString(record.resultCommit),
    failureReason: asString(record.failureReason),
    noOp: asBoolean(record.noOp),
    stopPending: asBoolean(record.stopPending),
    finishedAt: asString(record.finishedAt),
    summary: asString(record.summary),
  };
}

function summarizeWorkflowRegistryRecord(
  record: WorkflowRegistryRecord,
): WorkflowSummary | null {
  const workflow = asRecord(record.workflow);
  const key = asString(record.key);
  const workflowPath = asString(record.workflowPath);
  const id = asString(workflow.id);
  const title = asString(workflow.title) || id;
  const projectRoot = asString(workflow.projectRoot);
  if (!key || !workflowPath || !id || !title || !projectRoot) {
    return null;
  }

  const scheduler = asRecord(record.scheduler);
  const settings = asRecord(record.settings);
  const taskCounts = normalizeTaskCounts(asRecord(record.taskCounts));
  const recentOutcomes = Array.isArray(record.recentOutcomes)
    ? record.recentOutcomes
        .map((entry) => normalizeRecentOutcome(entry))
        .filter((entry): entry is WorkflowRecentOutcome => Boolean(entry))
    : [];

  return {
    key,
    workflowPath,
    id,
    title,
    status: normalizeWorkflowStatus(workflow.status),
    projectRoot,
    projectName: basename(projectRoot) || projectRoot,
    targetBranch: asString(workflow.targetBranch),
    updatedAt: asString(workflow.updatedAt),
    createdAt: asString(workflow.createdAt),
    request: asString(workflow.request),
    boundSessionId: asString(workflow.boundSession),
    schedulerRunning: asBoolean(scheduler.running),
    schedulerPendingTrigger: asBoolean(scheduler.pendingTrigger),
    schedulerLastSessionId: asString(scheduler.lastSessionId),
    schedulerThreadId: asString(scheduler.threadId),
    schedulerLastReason: asString(scheduler.lastReason),
    schedulerLastRunAt: asString(scheduler.lastRunAt),
    schedulerLastTurnStatus: asString(scheduler.lastTurnStatus),
    maxParallel: asNumber(settings.maxParallel),
    mergePolicy: asString(settings.mergePolicy),
    taskCounts,
    recentOutcomes,
  };
}

function buildRecentWorkflowOutcomes(tasks: JsonObject[]): JsonObject[] {
  const outcomes: JsonObject[] = [];
  for (const task of tasks) {
    const taskId = asString(task.id);
    if (!taskId) {
      continue;
    }
    const status = normalizeTaskStatus(task.status);
    if (status !== "success" && status !== "failed" && status !== "cancelled") {
      continue;
    }
    const summary = asString(task.summary);
    outcomes.push({
      taskId,
      status,
      resultCommit: asString(task.resultCommit),
      failureReason: asString(task.failureReason),
      noOp: asBoolean(task.noOp),
      stopPending: asBoolean(task.stopPending),
      finishedAt: asString(task.finishedAt),
      summary:
        summary && summary.length > 220
          ? `${summary.slice(0, 217).trimEnd()}...`
          : summary,
    });
  }

  return outcomes
    .sort((a, b) => {
      const aFinished = Date.parse(asString(a.finishedAt) || "") || 0;
      const bFinished = Date.parse(asString(b.finishedAt) || "") || 0;
      return bFinished - aFinished;
    })
    .slice(0, 5);
}

function buildCreateConflictPayload(
  projectRoot: string,
  workflowId: string,
): {
  requestedId: string;
  conflictingPath: string;
  suggestedIds: string[];
  suggestedPath: string | null;
} {
  const requestedId = sanitizeWorkflowId(workflowId);
  const conflictingPath = workflowFile(projectRoot, requestedId);
  const suggestedIds: string[] = [];
  let suffix = 2;
  while (suggestedIds.length < DEFAULT_CREATE_SUGGESTION_COUNT) {
    const candidateId = `${requestedId}-${suffix}`;
    if (!existsSync(workflowFile(projectRoot, candidateId))) {
      suggestedIds.push(candidateId);
    }
    suffix += 1;
  }
  return {
    requestedId,
    conflictingPath,
    suggestedIds,
    suggestedPath:
      suggestedIds.length > 0 ? workflowFile(projectRoot, suggestedIds[0]) : null,
  };
}

function formatCreateConflictError(payload: {
  requestedId: string;
  conflictingPath: string;
  suggestedIds: string[];
  suggestedPath: string | null;
}): string {
  const lines = [
    `error: workflow already exists: ${payload.conflictingPath}`,
    `requested workflow id: ${payload.requestedId}`,
  ];
  if (payload.suggestedIds[0]) {
    lines.push(`suggested workflow id: ${payload.suggestedIds[0]}`);
  }
  if (payload.suggestedPath) {
    lines.push(`suggested workflow path: ${payload.suggestedPath}`);
  }
  if (payload.suggestedIds.length > 1) {
    lines.push(
      `other suggested workflow ids: ${payload.suggestedIds.slice(1).join(", ")}`,
    );
  }
  return lines.join("\n");
}

function buildRegistryRecordFromWorkflowPayload(
  registryKey: string,
  workflowPath: string,
  raw: JsonObject,
): WorkflowRegistryRecord {
  const workflow = asRecord(raw.workflow);
  const scheduler = asRecord(raw.scheduler);
  const settings = asRecord(raw.settings);
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((task) => asRecord(task))
    : [];

  const taskCounts = {
    total: tasks.length,
    cancelled: tasks.filter(
      (task) => normalizeTaskStatus(task.status) === "cancelled",
    ).length,
    failed: tasks.filter(
      (task) => normalizeTaskStatus(task.status) === "failed",
    ).length,
    pending: tasks.filter(
      (task) => normalizeTaskStatus(task.status) === "pending",
    ).length,
    running: tasks.filter(
      (task) => normalizeTaskStatus(task.status) === "running",
    ).length,
    success: tasks.filter(
      (task) => normalizeTaskStatus(task.status) === "success",
    ).length,
  };
  const sessionIndex = buildWorkflowSessionIndexRecordsFromWorkflowPayload(
    registryKey,
    workflowPath,
    raw,
  );
  const workflowRecord: Record<string, unknown> = {
    id: asString(workflow.id) || basename(workflowPath, ".json"),
    title:
      asString(workflow.title) ||
      asString(workflow.id) ||
      basename(workflowPath, ".json"),
    status: normalizeWorkflowStatus(workflow.status),
    projectRoot:
      asString(workflow.projectRoot) || resolve(workflowPath, "..", ".."),
    targetBranch: asString(workflow.targetBranch),
    updatedAt: asString(workflow.updatedAt),
    createdAt: asString(workflow.createdAt),
    request: asString(workflow.request),
  };
  const boundSession = asString(workflow.boundSession);
  if (boundSession) {
    workflowRecord.boundSession = boundSession;
  }

  return {
    key: registryKey,
    workflowPath,
    workflow: workflowRecord,
    scheduler: {
      running: asBoolean(scheduler.running),
      pendingTrigger: asBoolean(scheduler.pendingTrigger),
      lastSessionId: asString(scheduler.lastSessionId),
      threadId: asString(scheduler.threadId),
      lastReason: asString(scheduler.lastReason),
      lastRunAt: asString(scheduler.lastRunAt),
      lastTurnStatus: asString(scheduler.lastTurnStatus),
    },
    settings: {
      codexHome: asString(settings.codexHome),
      maxParallel: asNumber(settings.maxParallel),
      mergePolicy: asString(settings.mergePolicy),
    },
    sessionIndex: sessionIndex.map((entry) => ({
      sessionId: entry.sessionId,
      type: entry.type,
      taskId: entry.taskId,
    })),
    taskCounts,
    recentOutcomes: buildRecentWorkflowOutcomes(tasks),
  };
}

function buildWorkflowSessionIndexRecordsFromWorkflowPayload(
  registryKey: string,
  workflowPath: string,
  raw: JsonObject,
): WorkflowSessionIndexRecord[] {
  const workflow = asRecord(raw.workflow);
  const scheduler = asRecord(raw.scheduler);
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((task) => asRecord(task))
    : [];

  const workflowId = asString(workflow.id) || basename(workflowPath, ".json");
  const workflowTitle =
    asString(workflow.title) || workflowId || basename(workflowPath, ".json");
  const projectRoot =
    asString(workflow.projectRoot) || resolve(workflowPath, "..", "..");
  const updatedAt = asString(workflow.updatedAt);

  const records: WorkflowSessionIndexRecord[] = [];
  const seen = new Set<string>();

  const addRecord = (
    sessionId: string | null,
    type: WorkflowSessionIndexRecord["type"],
    taskId: string | null = null,
  ): void => {
    if (!sessionId || seen.has(sessionId)) {
      return;
    }
    seen.add(sessionId);
    records.push({
      sessionId,
      type,
      workflowKey: registryKey,
      workflowId,
      workflowTitle,
      workflowPath,
      projectRoot,
      taskId,
      updatedAt,
    });
  };

  addRecord(asString(workflow.boundSession), "bound");
  addRecord(
    asString(scheduler.lastSessionId) || asString(scheduler.threadId),
    "scheduler",
  );
  for (const task of tasks) {
    addRecord(asString(task.sessionId), "task", asString(task.id));
  }

  return records;
}

function normalizeWorkflowSessionIndexSummary(
  value: unknown,
): WorkflowSessionIndexSummary | null {
  const record = asRecord(value);
  const sessionId = asString(record.sessionId);
  const type = asString(record.type);
  if (
    !sessionId ||
    (type !== "bound" && type !== "scheduler" && type !== "task")
  ) {
    return null;
  }
  return {
    sessionId,
    type,
    taskId: asString(record.taskId),
  };
}

function normalizeWorkflowSessionIndexRecord(
  value: unknown,
): WorkflowSessionIndexRecord | null {
  const record = asRecord(value);
  const sessionId = asString(record.sessionId);
  const type = asString(record.type);
  const workflowKey = asString(record.workflowKey);
  const workflowId = asString(record.workflowId);
  const workflowTitle = asString(record.workflowTitle);
  const workflowPath = asString(record.workflowPath);
  const projectRoot = asString(record.projectRoot);
  if (
    !sessionId ||
    !workflowKey ||
    !workflowId ||
    !workflowTitle ||
    !workflowPath ||
    !projectRoot ||
    (type !== "bound" && type !== "scheduler" && type !== "task")
  ) {
    return null;
  }
  return {
    sessionId,
    type,
    workflowKey,
    workflowId,
    workflowTitle,
    workflowPath,
    projectRoot,
    taskId: asString(record.taskId),
    updatedAt: asString(record.updatedAt),
  };
}

function readSessionIndexSummaryFromRegistryRecord(
  record: WorkflowRegistryRecord,
): WorkflowSessionIndexSummary[] {
  return Array.isArray(record.sessionIndex)
    ? record.sessionIndex
        .map((entry) => normalizeWorkflowSessionIndexSummary(entry))
        .filter((entry): entry is WorkflowSessionIndexSummary => Boolean(entry))
    : [];
}

async function syncWorkflowSessionIndex(
  codexHome: string | null | undefined,
  workflowPath: string,
  desiredEntries: WorkflowSessionIndexRecord[],
  previousEntries: WorkflowSessionIndexSummary[],
): Promise<void> {
  const sessionIndexDir = getSessionIndexDir(codexHome);
  await mkdir(sessionIndexDir, { recursive: true });

  const desiredSessionIds = new Set(
    desiredEntries.map((entry) => entry.sessionId).filter(Boolean),
  );

  for (const entry of desiredEntries) {
    const sessionIndexPath = join(sessionIndexDir, `${entry.sessionId}.json`);
    try {
      const existing = (await readJsonFile(sessionIndexPath)) as Record<
        string,
        unknown
      >;
      const existingWorkflowPath = asString(existing.workflowPath);
      if (existingWorkflowPath && existingWorkflowPath !== workflowPath) {
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await writeTextFileAtomic(
      sessionIndexPath,
      JSON.stringify(entry, null, 2) + "\n",
    );
  }

  for (const entry of previousEntries) {
    if (!entry.sessionId || desiredSessionIds.has(entry.sessionId)) {
      continue;
    }
    const sessionIndexPath = join(sessionIndexDir, `${entry.sessionId}.json`);
    try {
      const existing = (await readJsonFile(sessionIndexPath)) as Record<
        string,
        unknown
      >;
      if (asString(existing.workflowPath) !== workflowPath) {
        continue;
      }
      await rm(sessionIndexPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function loadWorkflowSummaryFromRegistryEntry(
  registryPath: string,
): Promise<WorkflowSummary | null> {
  const registryText = await readFile(registryPath, "utf-8");
  const registryPayload = asRecord(
    JSON.parse(registryText),
  ) as WorkflowRegistryRecord;
  const registryKey =
    asString(registryPayload.key) || basename(registryPath, ".json");
  const workflowPath = asString(registryPayload.workflowPath);

  if (workflowPath) {
    try {
      const canonicalPayload = await readJsonFile(workflowPath);
      const refreshedRecord = buildRegistryRecordFromWorkflowPayload(
        registryKey,
        workflowPath,
        canonicalPayload,
      );
      await syncWorkflowSessionIndex(
        asString(asRecord(refreshedRecord.settings).codexHome),
        workflowPath,
        buildWorkflowSessionIndexRecordsFromWorkflowPayload(
          registryKey,
          workflowPath,
          canonicalPayload,
        ),
        readSessionIndexSummaryFromRegistryRecord(registryPayload),
      );
      const refreshedText = JSON.stringify(refreshedRecord, null, 2) + "\n";
      if (refreshedText !== registryText) {
        await writeTextFileAtomic(registryPath, refreshedText);
      }
      return summarizeWorkflowRegistryRecord(refreshedRecord);
    } catch {
      // Fall back to the existing mirrored metadata when the canonical file is unavailable.
    }
  }

  return summarizeWorkflowRegistryRecord({
    ...registryPayload,
    key: registryKey,
  });
}

export async function getWorkflowSummaryByKey(
  key: string,
  codexHome?: string | null,
): Promise<WorkflowSummary | null> {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    throw new Error("workflow key is required");
  }

  try {
    return await loadWorkflowSummaryFromRegistryEntry(
      join(getRegistryDir(codexHome), `${trimmedKey}.json`),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function ensureWorkflowRegistryBackfill(
  codexHome?: string | null,
  options?: WorkflowBackfillOptions,
): Promise<void> {
  try {
    await runCodexDeckCommand(
      ["backfill-registry", ...(codexHome ? ["--codex-home", codexHome] : [])],
      { codexHome },
    );
  } catch (error) {
    if (options?.required || !isWorkflowBackendUnavailableError(error)) {
      throw error;
    }
  }
}

export async function listWorkflows(
  codexHome?: string | null,
): Promise<WorkflowSummary[]> {
  await ensureWorkflowRegistryBackfill(codexHome);
  const registryDir = getRegistryDir(codexHome);
  let entries: string[] = [];
  try {
    entries = (await readdir(registryDir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const summaries: Array<WorkflowSummary | null> = [];
  for (const entry of entries.filter((entry) => entry.endsWith(".json"))) {
    try {
      summaries.push(
        await loadWorkflowSummaryFromRegistryEntry(join(registryDir, entry)),
      );
    } catch {
      summaries.push(null);
    }
  }

  return summaries
    .filter((summary): summary is WorkflowSummary => Boolean(summary))
    .sort((a, b) => {
      const runningDelta =
        Number(b.schedulerRunning) - Number(a.schedulerRunning);
      if (runningDelta !== 0) {
        return runningDelta;
      }
      const aUpdated = Date.parse(a.updatedAt || "") || 0;
      const bUpdated = Date.parse(b.updatedAt || "") || 0;
      return bUpdated - aUpdated;
    });
}

export async function getWorkflowBySessionId(
  sessionId: string,
  codexHome?: string | null,
): Promise<WorkflowSessionLookupResponse | null> {
  const trimmedSessionId = sessionId.trim();
  if (!trimmedSessionId) {
    throw new Error("session id is required");
  }

  await ensureWorkflowRegistryBackfill(codexHome);
  const sessionIndexPath = join(
    getSessionIndexDir(codexHome),
    `${trimmedSessionId}.json`,
  );
  let sessionIndexRecord: WorkflowSessionIndexRecord | null = null;
  try {
    sessionIndexRecord = normalizeWorkflowSessionIndexRecord(
      await readJsonFile(sessionIndexPath),
    );
  } catch (error) {
    if (isIgnorableWorkflowIndexReadError(error)) {
      return null;
    }
    throw error;
  }
  if (!sessionIndexRecord) {
    return null;
  }

  const summary = await loadWorkflowSummaryFromRegistryEntry(
    join(getRegistryDir(codexHome), `${sessionIndexRecord.workflowKey}.json`),
  );
  if (!summary) {
    return null;
  }

  return {
    sessionId: trimmedSessionId,
    role: sessionIndexRecord.type,
    taskId: sessionIndexRecord.taskId,
    workflow: summary,
  };
}

export async function getWorkflowSessionRoles(
  sessionIds: string[],
  codexHome?: string | null,
): Promise<WorkflowSessionRoleSummary[]> {
  const normalizedSessionIds = [
    ...new Set(
      sessionIds
        .map((sessionId) => sessionId.trim())
        .filter((sessionId) => sessionId.length > 0),
    ),
  ];
  if (normalizedSessionIds.length === 0) {
    return [];
  }

  await ensureWorkflowRegistryBackfill(codexHome);

  const roles = await Promise.all(
    normalizedSessionIds.map(async (sessionId) => {
      try {
        const sessionIndexRecord = normalizeWorkflowSessionIndexRecord(
          await readJsonFile(
            join(getSessionIndexDir(codexHome), `${sessionId}.json`),
          ),
        );
        if (!sessionIndexRecord) {
          return null;
        }

        return {
          sessionId: sessionIndexRecord.sessionId,
          role: sessionIndexRecord.type,
          taskId: sessionIndexRecord.taskId,
        } satisfies WorkflowSessionRoleSummary;
      } catch (error) {
        if (isIgnorableWorkflowIndexReadError(error)) {
          return null;
        }
        throw error;
      }
    }),
  );

  return roles.filter((role): role is WorkflowSessionRoleSummary =>
    Boolean(role),
  );
}

function normalizeWorkflowTask(
  task: unknown,
  readyTaskIds: Set<string>,
): WorkflowTaskSummary | null {
  const record = asRecord(task);
  const id = asString(record.id);
  const name = asString(record.name);
  if (!id || !name) {
    return null;
  }
  const dependsOn = Array.isArray(record.dependsOn)
    ? record.dependsOn
        .map((dep) => asString(dep))
        .filter((dep): dep is string => Boolean(dep))
    : [];
  return {
    id,
    name,
    prompt: asString(record.prompt) || "",
    dependsOn,
    status: normalizeTaskStatus(record.status),
    sessionId: asString(record.sessionId),
    branchName: asString(record.branchName),
    worktreePath: asString(record.worktreePath),
    baseCommit: asString(record.baseCommit),
    resultCommit: asString(record.resultCommit),
    startedAt: asString(record.startedAt),
    finishedAt: asString(record.finishedAt),
    summary: asString(record.summary),
    failureReason: asString(record.failureReason),
    noOp: asBoolean(record.noOp),
    stopPending: asBoolean(record.stopPending),
    runnerPid: asNumber(record.runnerPid),
    ready: readyTaskIds.has(id),
  };
}

function normalizeWorkflowHistoryEntry(
  value: unknown,
): WorkflowHistoryEntry | null {
  const record = asRecord(value);
  const type = asString(record.type);
  if (!type) {
    return null;
  }
  return {
    at: asString(record.at),
    type,
    details: asRecord(record.details),
  };
}

function normalizeSchedulerState(record: JsonObject): WorkflowSchedulerState {
  const controllerMessages = Array.isArray(record.controlMessages)
    ? record.controlMessages.map((message) => {
        const item = asRecord(message);
        return {
          requestId: asString(item.requestId),
          type: asString(item.type),
          payload:
            Object.keys(asRecord(item.payload)).length > 0
              ? asRecord(item.payload)
              : null,
          createdAt: asString(item.createdAt),
        };
      })
    : [];

  return {
    running: asBoolean(record.running),
    pendingTrigger: asBoolean(record.pendingTrigger),
    lastRunAt: asString(record.lastRunAt),
    lastSessionId: asString(record.lastSessionId),
    threadId: asString(record.threadId),
    lastTurnId: asString(record.lastTurnId),
    lastTurnStatus: asString(record.lastTurnStatus),
    lastReason: asString(record.lastReason),
    controllerMode: asString(record.controllerMode),
    controller: asRecord(record.controller),
    builtInPrompt: asString(record.builtInPrompt),
    lastComposedPrompt: asString(record.lastComposedPrompt),
    controlMessages: controllerMessages,
  };
}

function resolveReadyTaskIds(raw: JsonObject): Set<string> {
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((task) => asRecord(task))
    : [];
  const taskStatusById = new Map<string, WorkflowTaskStatus>();
  for (const task of tasks) {
    const id = asString(task.id);
    if (!id) {
      continue;
    }
    taskStatusById.set(id, normalizeTaskStatus(task.status));
  }

  const ready = new Set<string>();
  for (const task of tasks) {
    const id = asString(task.id);
    if (!id || normalizeTaskStatus(task.status) !== "pending") {
      continue;
    }
    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn
          .map((dep) => asString(dep))
          .filter((dep): dep is string => Boolean(dep))
      : [];
    const isReady = dependsOn.every(
      (dep) => taskStatusById.get(dep) === "success",
    );
    if (isReady) {
      ready.add(id);
    }
  }
  return ready;
}

export async function getWorkflowDetail(
  key: string,
  codexHome?: string | null,
): Promise<WorkflowDetailResponse> {
  const summaries = await listWorkflows(codexHome);
  const summary = summaries.find((item) => item.key === key);
  if (!summary) {
    throw new Error("workflow not found");
  }

  const raw = await readJsonFile(summary.workflowPath);
  const workflow = asRecord(raw.workflow);
  const boundSessionId = asString(workflow.boundSession);
  const readyTaskIds = resolveReadyTaskIds(raw);
  const settings = asRecord(raw.settings);
  const scheduler = normalizeSchedulerState(asRecord(raw.scheduler));
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks
        .map((task) => normalizeWorkflowTask(task, readyTaskIds))
        .filter((task): task is WorkflowTaskSummary => Boolean(task))
    : [];
  const history = Array.isArray(raw.history)
    ? raw.history
        .map((entry) => normalizeWorkflowHistoryEntry(entry))
        .filter((entry): entry is WorkflowHistoryEntry => Boolean(entry))
    : [];

  return {
    summary: {
      ...summary,
      boundSessionId,
    },
    boundSessionId,
    settings: {
      codexHome: asString(settings.codexHome),
      codexCliPath: asString(settings.codexCliPath),
      maxParallel: asNumber(settings.maxParallel),
      mergePolicy: asString(settings.mergePolicy),
      stopSignal: asString(settings.stopSignal),
    },
    scheduler,
    tasks,
    history,
    raw,
  };
}

export async function getWorkflowLog(
  key: string,
  scope: "scheduler" | "task" | "daemon",
  taskId?: string | null,
  codexHome?: string | null,
): Promise<WorkflowLogResponse> {
  const summaries = await listWorkflows(codexHome);
  const summary = summaries.find((item) => item.key === key);
  if (!summary) {
    throw new Error("workflow not found");
  }

  const workflowPath = summary.workflowPath;
  const workflowDir = resolve(workflowPath, "..");
  let logPath: string | null = null;
  if (scope === "scheduler") {
    logPath = join(workflowDir, "logs", "scheduler.log");
  } else if (scope === "task") {
    if (!taskId) {
      throw new Error("taskId is required for task logs");
    }
    logPath = join(workflowDir, "logs", `${taskId}.log`);
  } else {
    const daemonStatus = await getWorkflowDaemonStatus(codexHome);
    logPath = daemonStatus.daemonLogPath;
  }

  if (!logPath) {
    return {
      key,
      scope,
      taskId: taskId ?? null,
      path: null,
      content: "",
      unavailableReason: "log file is unavailable",
    };
  }

  try {
    const content = await readFile(logPath, "utf-8");
    return {
      key,
      scope,
      taskId: taskId ?? null,
      path: logPath,
      content,
      unavailableReason: null,
    };
  } catch (error) {
    const unavailableReason =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "log file not found"
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      key,
      scope,
      taskId: taskId ?? null,
      path: logPath,
      content: "",
      unavailableReason,
    };
  }
}

export async function getWorkflowDaemonStatus(
  codexHome?: string | null,
): Promise<WorkflowDaemonStatusResponse> {
  const statePath = getDaemonStatePath(codexHome);
  try {
    const payload = await readJsonFile(statePath);
    return {
      state: asString(payload.state) || "stopped",
      pid: asNumber(payload.pid),
      port: asNumber(payload.port),
      startedAt: asString(payload.startedAt),
      lastHeartbeatAt: asString(payload.lastHeartbeatAt),
      lastRequestAt: asString(payload.lastRequestAt),
      queueDepth: asNumber(payload.queueDepth),
      activeProjects: Array.isArray(payload.activeProjects)
        ? payload.activeProjects
            .map((value) => asString(value))
            .filter((value): value is string => Boolean(value))
        : [],
      activeWorkflows: Array.isArray(payload.activeWorkflows)
        ? payload.activeWorkflows
            .map((value) => asString(value))
            .filter((value): value is string => Boolean(value))
        : [],
      daemonId: asString(payload.daemonId),
      daemonLogPath: asString(payload.daemonLogPath),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return {
      state: "stopped",
      pid: null,
      port: null,
      startedAt: null,
      lastHeartbeatAt: null,
      lastRequestAt: null,
      queueDepth: 0,
      activeProjects: [],
      activeWorkflows: [],
      daemonId: null,
      daemonLogPath: null,
    };
  }
}

async function runCodexDeckCommand(
  args: string[],
  options?: { codexHome?: string | null },
): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const env = {
      ...process.env,
      ...(options?.codexHome ? { CODEX_HOME: options.codexHome } : {}),
      CODEX_DECK_RUNNER: "api",
    };
    if (process.platform === "win32" && !env.PYTHON_BIN) {
      env.PYTHON_BIN = "python";
    }

    const child = spawn(
      process.platform === "win32" ? "bash" : RUN_SCRIPT_PATH,
      process.platform === "win32" ? [RUN_SCRIPT_PATH, ...args] : args,
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
        env,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            stdout.trim() ||
            `codex-deck command failed with exit code ${code}`,
        ),
      );
    });
  });
}

async function runGitCommand(
  projectRoot: string,
  args: string[],
): Promise<GitCommandResult> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function detectTargetBranch(projectRoot: string): Promise<string> {
  const commands = [
    ["branch", "--show-current"],
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    ["rev-parse", "--abbrev-ref", "HEAD"],
  ];
  for (const args of commands) {
    try {
      const result = await runGitCommand(projectRoot, args);
      const output = result.stdout.trim();
      if (result.code === 0 && output && output !== "HEAD") {
        return output;
      }
    } catch {
      continue;
    }
  }
  return DEFAULT_TARGET_BRANCH_FALLBACK;
}

async function listGitWorktrees(
  projectRoot: string,
): Promise<Array<{ path: string; branch: string }>> {
  const result = await runGitCommand(projectRoot, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (result.code !== 0) {
    return [];
  }

  const entries: Array<{ path: string; branch: string }> = [];
  let currentPath: string | null = null;
  let currentBranch = "";
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      if (currentPath) {
        entries.push({
          path: resolve(currentPath),
          branch: currentBranch,
        });
      }
      currentPath = null;
      currentBranch = "";
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length).trim();
    }
  }

  if (currentPath) {
    entries.push({
      path: resolve(currentPath),
      branch: currentBranch,
    });
  }
  return entries;
}

async function listGitBranches(projectRoot: string): Promise<Set<string>> {
  const result = await runGitCommand(projectRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (result.code !== 0) {
    return new Set();
  }
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

function collectWorkflowSessionIds(
  workflowPayload: JsonObject | null,
  registryPayload: WorkflowRegistryRecord | null,
): Set<string> {
  const sessionIds = new Set<string>();
  const workflow = asRecord(workflowPayload?.workflow);
  const scheduler = asRecord(workflowPayload?.scheduler);
  const tasks = Array.isArray(workflowPayload?.tasks)
    ? workflowPayload.tasks.map((task) => asRecord(task))
    : [];

  for (const sessionId of [
    asString(workflow.boundSession),
    asString(scheduler.lastSessionId),
    asString(scheduler.threadId),
    ...tasks.map((task) => asString(task.sessionId)),
  ]) {
    if (sessionId) {
      sessionIds.add(sessionId);
    }
  }

  if (registryPayload) {
    for (const entry of readSessionIndexSummaryFromRegistryRecord(
      registryPayload,
    )) {
      if (entry.sessionId) {
        sessionIds.add(entry.sessionId);
      }
    }
  }

  return sessionIds;
}

function collectWorkflowBranchNames(
  summary: WorkflowSummary,
  workflowPayload: JsonObject | null,
): Set<string> {
  const branches = new Set<string>();
  if (summary.id.trim()) {
    branches.add(`flow/${summary.id.trim()}/integration`);
  }

  const tasks = Array.isArray(workflowPayload?.tasks)
    ? workflowPayload.tasks.map((task) => asRecord(task))
    : [];
  for (const branchName of tasks.map((task) => asString(task.branchName))) {
    if (branchName) {
      branches.add(branchName);
    }
  }

  return branches;
}

function collectWorkflowWorktreePaths(
  summary: WorkflowSummary,
  workflowPayload: JsonObject | null,
): Set<string> {
  const worktreePaths = new Set<string>();
  const flowWorktreesDir = join(
    summary.projectRoot,
    ".codex-deck",
    "worktrees",
  );
  const tasks = Array.isArray(workflowPayload?.tasks)
    ? workflowPayload.tasks.map((task) => asRecord(task))
    : [];

  for (const worktreePath of tasks.map((task) => asString(task.worktreePath))) {
    if (!worktreePath) {
      continue;
    }
    const resolvedWorktreePath = resolve(worktreePath);
    if (isPathWithinDirectory(resolvedWorktreePath, flowWorktreesDir)) {
      worktreePaths.add(resolvedWorktreePath);
    }
  }

  return worktreePaths;
}

function commandResponse(
  command: string,
  workflowKey: string | null,
  output: string | null,
): WorkflowActionResponse {
  return {
    ok: true,
    command,
    workflowKey,
    output,
  };
}

function parseDaemonResultOutput(output: string): JsonObject | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

interface ResolvedWorkflow {
  summary: WorkflowSummary;
  codexHome: string | null;
}

async function resolveWorkflowByKey(key: string): Promise<ResolvedWorkflow> {
  const summaries = await listWorkflows();
  const summary = summaries.find((item) => item.key === key);
  if (!summary) {
    throw new Error("workflow not found");
  }
  const registryDir = getRegistryDir();
  const payload = await readJsonFile(join(registryDir, `${key}.json`));
  const settings = asRecord(payload.settings);
  return {
    summary,
    codexHome: asString(settings.codexHome),
  };
}

async function writeWorkflowJson(
  path: string,
  payload: JsonObject,
): Promise<void> {
  await writeTextFileAtomic(path, JSON.stringify(payload, null, 2) + "\n");
}

function defaultTaskPrompt(userRequest: string, taskName: string): string {
  return (
    "Workflow context:\n" +
    `- Overall request: ${userRequest}\n` +
    `- Assigned task: ${taskName}\n\n` +
    "Execution contract:\n" +
    "- Work only on this assigned task in the provided branch/worktree.\n" +
    "- Avoid redoing sibling tasks or broad workflow orchestration.\n" +
    "- Run relevant tests/build checks for your changes.\n" +
    "- Commit your final changes with a clear commit message if you make code changes.\n" +
    "- In your final summary, explain what changed in user-facing terms.\n" +
    "- If this is a feature, explain how a user can use the project to see it.\n" +
    "- If this is a bug fix, explain how to reproduce the old problem and how to verify the fix.\n" +
    "- If this is an internal/refactor change, explain what behavior should remain the same and what to inspect.\n" +
    "- If no code changes are required, clearly state `no-op` in the final summary.\n" +
    `- Only include \`${DEFAULT_STOP_SIGNAL}\` in the final summary if completing this task truly makes remaining pending tasks unnecessary.`
  );
}

function buildWorkflowTasks(
  input: CreateWorkflowRequest,
  workflowId: string,
): JsonObject[] {
  if (input.tasksJson?.trim()) {
    const parsed = JSON.parse(input.tasksJson) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("tasks json must be an array");
    }

    const tasks: JsonObject[] = [];
    for (const [index, item] of parsed.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const taskId = sanitizeWorkflowId(
        String(record.id || `task-${index + 1}`),
      );
      const dependsOn = Array.isArray(record.dependsOn)
        ? record.dependsOn
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0)
            .map((value) => sanitizeWorkflowId(value))
        : [];
      tasks.push({
        id: taskId,
        name: String(record.name || `task-${index + 1}`),
        prompt:
          String(record.prompt || "") ||
          defaultTaskPrompt(input.request, taskId),
        dependsOn,
        status: "pending",
        sessionId: null,
        branchName:
          String(record.branchName || "") || `flow/${workflowId}/${taskId}`,
        worktreePath: null,
        baseCommit: null,
        resultCommit: null,
        startedAt: null,
        finishedAt: null,
        summary: null,
        failureReason: null,
        noOp: false,
        stopPending: false,
        runnerPid: null,
      });
    }
    return tasks;
  }

  const taskCount =
    typeof input.taskCount === "number" && Number.isFinite(input.taskCount)
      ? Math.max(1, Math.floor(input.taskCount))
      : 1;

  const tasks: JsonObject[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const taskNumber = index + 1;
    const taskId = sanitizeWorkflowId(`task-${taskNumber}`);
    tasks.push({
      id: taskId,
      name: `task-${taskNumber}`,
      prompt: defaultTaskPrompt(input.request, `task-${taskNumber}`),
      dependsOn:
        input.sequential && index > 0
          ? [sanitizeWorkflowId(`task-${taskNumber - 1}`)]
          : [],
      status: "pending",
      sessionId: null,
      branchName: `flow/${workflowId}/${taskId}`,
      worktreePath: null,
      baseCommit: null,
      resultCommit: null,
      startedAt: null,
      finishedAt: null,
      summary: null,
      failureReason: null,
      noOp: false,
      stopPending: false,
      runnerPid: null,
    });
  }
  return tasks;
}

function setWorkflowBoundSession(
  payload: JsonObject,
  sessionId: string | null,
): JsonObject {
  const workflow = asRecord(payload.workflow);
  if (sessionId) {
    workflow.boundSession = sessionId;
  } else {
    delete workflow.boundSession;
  }
  payload.workflow = workflow;
  return payload;
}

export async function createWorkflow(
  input: CreateWorkflowRequest,
  codexHome?: string | null,
): Promise<WorkflowCreateResponse> {
  const projectRoot = resolve(input.projectRoot?.trim() || process.cwd());
  const workflowId = sanitizeWorkflowId(input.workflowId?.trim() || input.title);
  const workflowPath = workflowFile(projectRoot, workflowId);
  const workflowDir = dirname(workflowPath);
  const workflowLockPath = `${workflowPath.slice(0, -".json".length)}.lock`;
  const codexHomeValue = resolve(codexHome?.trim() || defaultCodexHome());
  const registryKey = workflowRegistryKey(projectRoot, workflowId);
  const registryDir = getRegistryDir(codexHomeValue);
  const registryPath = join(registryDir, `${registryKey}.json`);
  const createdAt = nowIso();
  const tasks = buildWorkflowTasks(input, workflowId);
  const targetBranch = input.targetBranch?.trim()
    ? input.targetBranch.trim()
    : await detectTargetBranch(projectRoot);
  const payload: JsonObject = {
    workflow: {
      id: workflowId,
      title: input.title,
      createdAt,
      updatedAt: createdAt,
      status: "draft",
      targetBranch,
      projectRoot,
      request: input.request,
    },
    scheduler: {
      running: false,
      pendingTrigger: false,
      lastRunAt: null,
      lastSessionId: null,
      threadId: null,
      lastTurnId: null,
      lastTurnStatus: null,
      lastReason: null,
      controllerMode: "direct",
      controller: {
        daemonPid: null,
        daemonStartedAt: null,
        lastHeartbeatAt: null,
        lastEnqueueAt: null,
        lastDequeuedAt: null,
        activeRequestId: null,
      },
      builtInPrompt: DEFAULT_SCHEDULER_PROMPT,
      lastComposedPrompt: null,
    },
    settings: {
      codexHome: codexHomeValue,
      codexCliPath: defaultCodexCliPath(),
      maxParallel:
        typeof input.maxParallel === "number" && Number.isFinite(input.maxParallel)
          ? Math.max(1, Math.floor(input.maxParallel))
          : 1,
      mergePolicy: DEFAULT_WORKFLOW_MERGE_POLICY,
      stopSignal: DEFAULT_STOP_SIGNAL,
    },
    tasks,
    history: [
      {
        at: createdAt,
        type: "workflow_created",
        details: {
          taskCount: tasks.length,
        },
      },
    ],
  };
  const sessionIndexEntries = buildWorkflowSessionIndexRecordsFromWorkflowPayload(
    registryKey,
    workflowPath,
    payload,
  );
  const registryPayload = buildRegistryRecordFromWorkflowPayload(
    registryKey,
    workflowPath,
    payload,
  );
  let workflowReserved = false;
  try {
    await mkdir(workflowDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await writeFile(workflowLockPath, "", { flag: "a" });
    await writeFile(workflowPath, "", { flag: "wx" });
    workflowReserved = true;
    await writeWorkflowJson(workflowPath, payload);
    await syncWorkflowSessionIndex(
      codexHomeValue,
      workflowPath,
      sessionIndexEntries,
      [],
    );
    await writeTextFileAtomic(
      registryPath,
      JSON.stringify(registryPayload, null, 2) + "\n",
    );
    return {
      ok: true,
      command: "create",
      workflowKey: registryKey,
      workflowPath,
      output: workflowPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        formatCreateConflictError(
          buildCreateConflictPayload(projectRoot, workflowId),
        ),
      );
    }
    if (workflowReserved) {
      await rm(workflowPath, { force: true }).catch(() => {});
      await rm(registryPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function validateWorkflow(
  key: string,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const output = await runCodexDeckCommand(
    ["validate", "--workflow", summary.workflowPath],
    { codexHome },
  );
  return commandResponse("validate", key, output || "ok");
}

export async function reconcileWorkflow(
  key: string,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const output = await runCodexDeckCommand(
    ["reconcile", "--workflow", summary.workflowPath],
    { codexHome },
  );
  return commandResponse("reconcile", key, output || "ok");
}

export async function triggerWorkflow(
  key: string,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const output = await runCodexDeckCommand(
    ["trigger", "--workflow", summary.workflowPath],
    { codexHome },
  );
  return commandResponse("trigger", key, output || "ok");
}

export async function stopWorkflowProcesses(
  key: string,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const output = await runCodexDeckCommand(
    ["stop-workflow-processes", "--workflow", summary.workflowPath],
    { codexHome },
  );
  const daemonResult = parseDaemonResultOutput(output);
  const stoppedProcesses = asNumber(daemonResult?.stoppedProcesses);
  if (stoppedProcesses !== null) {
    return commandResponse(
      "stop-workflow-processes",
      key,
      `Stopped ${stoppedProcesses} process${stoppedProcesses === 1 ? "" : "es"}.`,
    );
  }
  return commandResponse(
    "stop-workflow-processes",
    key,
    output || "Stop request sent.",
  );
}

export async function launchWorkflowTask(
  key: string,
  taskId: string,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const output = await runCodexDeckCommand(
    ["launch-task", "--workflow", summary.workflowPath, "--task-id", taskId],
    { codexHome },
  );
  return commandResponse("launch-task", key, output);
}

export async function previewWorkflowMerge(
  key: string,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const output = await runCodexDeckCommand(
    ["merge", "--workflow", summary.workflowPath, "--preview"],
    { codexHome },
  );
  return commandResponse("merge-preview", key, output);
}

export async function applyWorkflowMerge(
  key: string,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const output = await runCodexDeckCommand(
    ["merge", "--workflow", summary.workflowPath, "--apply"],
    { codexHome },
  );
  return commandResponse("merge-apply", key, output);
}

export async function sendWorkflowControlMessage(
  key: string,
  request: WorkflowControlMessageRequest,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const payloadText = JSON.stringify(request.payload ?? {});
  const output = await runCodexDeckCommand(
    [
      "daemon-send",
      "--workflow",
      summary.workflowPath,
      "--type",
      request.type,
      "--reason",
      request.reason || "manual",
      "--payload-json",
      payloadText,
    ],
    { codexHome },
  );
  return commandResponse("control-message", key, output);
}

export async function bindWorkflowSession(
  key: string,
  request: WorkflowBindSessionRequest,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const sessionId = asString(request.sessionId);
  const workflowPayload = setWorkflowBoundSession(
    await readJsonFile(summary.workflowPath),
    sessionId,
  );
  const registryPath = join(getRegistryDir(codexHome), `${key}.json`);
  let previousRegistryPayload: WorkflowRegistryRecord = {};
  try {
    previousRegistryPayload = (await readJsonFile(
      registryPath,
    )) as WorkflowRegistryRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const refreshedRegistryPayload = buildRegistryRecordFromWorkflowPayload(
    key,
    summary.workflowPath,
    workflowPayload,
  );

  await writeWorkflowJson(summary.workflowPath, workflowPayload);
  await syncWorkflowSessionIndex(
    codexHome,
    summary.workflowPath,
    buildWorkflowSessionIndexRecordsFromWorkflowPayload(
      key,
      summary.workflowPath,
      workflowPayload,
    ),
    readSessionIndexSummaryFromRegistryRecord(previousRegistryPayload),
  );
  await writeTextFileAtomic(
    registryPath,
    JSON.stringify(refreshedRegistryPayload, null, 2) + "\n",
  );

  return commandResponse(
    "bind-session",
    key,
    sessionId
      ? `Bound workflow to session ${sessionId}.`
      : "Cleared bound workflow session.",
  );
}

export async function deleteWorkflow(
  key: string,
): Promise<WorkflowActionResponse> {
  const { summary, codexHome } = await resolveWorkflowByKey(key);
  const registryPath = join(getRegistryDir(codexHome), `${key}.json`);
  const sessionIndexDir = getSessionIndexDir(codexHome);
  const workflowPath = resolve(summary.workflowPath);
  const workflowLockPath = `${workflowPath.slice(0, -".json".length)}.lock`;
  const workflowPayload = await readOptionalJsonFile(workflowPath);
  const registryPayload = (await readOptionalJsonFile(
    registryPath,
  )) as WorkflowRegistryRecord | null;
  const sessionIds = collectWorkflowSessionIds(
    workflowPayload,
    registryPayload,
  );
  const worktreePaths = collectWorkflowWorktreePaths(summary, workflowPayload);
  const candidateBranches = collectWorkflowBranchNames(
    summary,
    workflowPayload,
  );
  const worktreeEntries = await listGitWorktrees(summary.projectRoot);
  const localBranches = await listGitBranches(summary.projectRoot);
  const outputLines: string[] = [];

  for (const worktreePath of Array.from(worktreePaths).sort()) {
    const worktreeEntry = worktreeEntries.find(
      (entry) => resolve(entry.path) === worktreePath,
    );
    if (worktreeEntry) {
      const result = await runGitCommand(summary.projectRoot, [
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]);
      if (result.code !== 0) {
        outputLines.push(
          `warning: failed to remove worktree via git: ${worktreePath} (${result.stderr || result.stdout || `exit ${result.code ?? "unknown"}`})`,
        );
      } else {
        outputLines.push(`removed worktree ${worktreePath}`);
      }
    }
    await rm(worktreePath, { recursive: true, force: true });
  }

  await runGitCommand(summary.projectRoot, [
    "worktree",
    "prune",
    "--expire",
    "now",
  ]).catch(() => {});

  const remainingWorktrees = await listGitWorktrees(summary.projectRoot);
  const inUseBranches = new Set(
    remainingWorktrees
      .map((entry) => entry.branch.trim())
      .filter((branch) => branch.length > 0),
  );
  for (const branch of Array.from(candidateBranches).sort()) {
    if (!localBranches.has(branch)) {
      continue;
    }
    if (inUseBranches.has(branch)) {
      outputLines.push(`warning: kept checked-out branch ${branch}`);
      continue;
    }
    const result = await runGitCommand(summary.projectRoot, [
      "branch",
      "-D",
      branch,
    ]);
    if (result.code === 0) {
      outputLines.push(`deleted branch ${branch}`);
      continue;
    }
    outputLines.push(
      `warning: failed to delete branch ${branch} (${result.stderr || result.stdout || `exit ${result.code ?? "unknown"}`})`,
    );
  }

  for (const sessionId of Array.from(sessionIds).sort()) {
    const sessionIndexPath = join(sessionIndexDir, `${sessionId}.json`);
    const sessionIndexPayload = await readOptionalJsonFile(sessionIndexPath);
    if (!sessionIndexPayload) {
      continue;
    }
    const indexedWorkflowKey = asString(sessionIndexPayload.workflowKey);
    const indexedWorkflowPath = asString(sessionIndexPayload.workflowPath);
    if (
      indexedWorkflowKey !== key &&
      indexedWorkflowPath !== workflowPath &&
      indexedWorkflowPath !== summary.workflowPath
    ) {
      continue;
    }
    await rm(sessionIndexPath, { force: true });
  }

  await rm(workflowLockPath, { force: true });
  await rm(workflowPath, { force: true });
  await rm(registryPath, { force: true });

  await rm(join(summary.projectRoot, ".codex-deck", "worktrees"), {
    recursive: false,
    force: true,
  }).catch(() => {});
  await rm(join(summary.projectRoot, ".codex-deck"), {
    recursive: false,
    force: true,
  }).catch(() => {});

  return commandResponse(
    "delete",
    key,
    outputLines.length > 0 ? outputLines.join("\n") : "Deleted workflow.",
  );
}

export async function startWorkflowDaemon(
  codexHome?: string | null,
): Promise<WorkflowActionResponse> {
  const output = await runCodexDeckCommand(["daemon-start"], { codexHome });
  return commandResponse("daemon-start", null, output || "ok");
}

export async function stopWorkflowDaemon(
  codexHome?: string | null,
): Promise<WorkflowActionResponse> {
  const output = await runCodexDeckCommand(["daemon-stop"], { codexHome });
  return commandResponse("daemon-stop", null, output || "ok");
}
