import { isRolloutFile, readRolloutPrefix } from "./rollout-files";
import { watch, type FSWatcher } from "chokidar";
import { basename, dirname, join } from "path";
import { isPathWithinDirectory } from "./path-utils";

type HistoryChangeCallback = () => void;
type SessionChangeCallback = (sessionId: string, filePath: string) => void;
type WorkflowChangeCallback = (workflowKey: string, filePath: string) => void;

let watcher: FSWatcher | null = null;
let codexDir = "";
let historyPath = "";
let sessionsDir = "";
let workflowsDir = "";
let workflowSessionIndexDir = "";
let workflowDaemonDir = "";
let diffGuidesDir = "";
let watcherReadyPromise: Promise<void> | null = null;
let watcherRefCount = 0;

const debounceTimers = new Map<string, NodeJS.Timeout>();
const debounceMs = 20;

const historyChangeListeners = new Set<HistoryChangeCallback>();
const sessionChangeListeners = new Set<SessionChangeCallback>();
const workflowChangeListeners = new Set<WorkflowChangeCallback>();
const diffGuideChangeListeners = new Set<() => void>();

export function onDiffGuideChange(callback: () => void): () => void {
  diffGuideChangeListeners.add(callback);
  return () => {
    diffGuideChangeListeners.delete(callback);
  };
}

export function initWatcher(dir: string): void {
  codexDir = dir;
  historyPath = join(codexDir, "history.jsonl");
  sessionsDir = join(codexDir, "sessions");
  workflowsDir = join(codexDir, "codex-deck", "workflows");
  workflowSessionIndexDir = join(workflowsDir, "session-index");
  workflowDaemonDir = join(workflowsDir, "daemon-state");
  diffGuidesDir = join(codexDir, "codex-deck", "diff", "sessions");
}

function getWatchRoots(): string[] {
  return [historyPath, sessionsDir, workflowsDir, diffGuidesDir]
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getWatchRootsForTests(): string[] {
  return [...getWatchRoots()];
}

function shouldIgnoreWatchPath(filePath: string): boolean {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    return false;
  }

  return !getWatchRoots().some(
    (root) =>
      trimmedPath === root ||
      isPathWithinDirectory(trimmedPath, root) ||
      isPathWithinDirectory(root, trimmedPath),
  );
}

export function shouldIgnoreWatchPathForTests(filePath: string): boolean {
  return shouldIgnoreWatchPath(filePath);
}

function shouldUsePollingForWatcher(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = env.CODEX_DECK_USE_POLLING?.trim();
  if (explicit === "1") {
    return true;
  }
  if (explicit === "0") {
    return false;
  }

  const legacy = env.CLAUDE_RUN_USE_POLLING?.trim();
  if (legacy === "1") {
    return true;
  }
  if (legacy === "0") {
    return false;
  }

  return platform === "win32";
}

export function shouldUsePollingForWatcherForTests(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
): boolean {
  return shouldUsePollingForWatcher(platform, env);
}

function extractSessionIdFromPath(filePath: string): string | null {
  const match = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i,
  );
  return match?.[1] ?? null;
}

async function readFirstLine(filePath: string): Promise<string | null> {
  try {
    const prefix = await readRolloutPrefix(filePath);
    const newline = prefix.indexOf(10);
    return (
      prefix
        .subarray(0, newline < 0 ? prefix.length : newline)
        .toString("utf8") || null
    );
  } catch {
    return null;
  }
}

async function extractSessionIdFromMeta(
  filePath: string,
): Promise<string | null> {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine) {
    return null;
  }

  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: string };
    };

    if (
      parsed.type === "session_meta" &&
      typeof parsed.payload?.id === "string" &&
      parsed.payload.id
    ) {
      return parsed.payload.id;
    }
  } catch {
    // Ignore malformed metadata lines.
  }

  return null;
}

async function emitChange(filePath: string): Promise<void> {
  if (basename(filePath) === "history.jsonl") {
    for (const callback of historyChangeListeners) {
      callback();
    }
    return;
  }

  if (
    !isRolloutFile(filePath) ||
    !isPathWithinDirectory(filePath, sessionsDir)
  ) {
    return;
  }

  let sessionId = extractSessionIdFromPath(filePath);
  if (!sessionId) {
    sessionId = await extractSessionIdFromMeta(filePath);
  }

  if (!sessionId) {
    return;
  }

  for (const callback of sessionChangeListeners) {
    callback(sessionId, filePath);
  }
}

function extractWorkflowKeyFromRegistryPath(filePath: string): string | null {
  if (
    !filePath.endsWith(".json") ||
    dirname(filePath) !== workflowsDir ||
    isPathWithinDirectory(filePath, workflowSessionIndexDir) ||
    isPathWithinDirectory(filePath, workflowDaemonDir)
  ) {
    return null;
  }

  const filename = basename(filePath, ".json").trim();
  return filename.length > 0 ? filename : null;
}

function emitWorkflowChange(filePath: string): void {
  const workflowKey = extractWorkflowKeyFromRegistryPath(filePath);
  if (!workflowKey) {
    return;
  }

  for (const callback of workflowChangeListeners) {
    callback(workflowKey, filePath);
  }
}

function handleChange(filePath: string): void {
  const existing = debounceTimers.get(filePath);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(filePath);
    if (
      isPathWithinDirectory(filePath, diffGuidesDir) ||
      filePath === diffGuidesDir
    ) {
      for (const callback of diffGuideChangeListeners) callback();
    }
    emitWorkflowChange(filePath);
    void emitChange(filePath);
  }, debounceMs);

  debounceTimers.set(filePath, timer);
}

export function startWatcher(): void {
  watcherRefCount += 1;

  if (watcher) {
    return;
  }

  const usePolling = shouldUsePollingForWatcher();

  watcher = watch(codexDir, {
    persistent: true,
    ignoreInitial: true,
    usePolling,
    ...(usePolling && { interval: 100 }),
    depth: 6,
    ignored: shouldIgnoreWatchPath,
  });

  watcher.on("change", handleChange);
  watcher.on("add", handleChange);
  watcher.on("unlink", handleChange);
  watcherReadyPromise = new Promise((resolve) => {
    watcher?.once("ready", () => {
      resolve();
    });
  });
  watcher.on("error", (error) => {
    console.error("Watcher error:", error);
  });
}

export async function waitForWatcherReady(
  timeoutMs: number = 5000,
): Promise<void> {
  const readyPromise = watcherReadyPromise;
  if (!readyPromise) {
    return;
  }

  await Promise.race([
    readyPromise,
    new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for watcher readiness after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    }),
  ]);
}

export function stopWatcher(): void {
  if (watcherRefCount > 0) {
    watcherRefCount -= 1;
  }

  if (watcherRefCount > 0) {
    return;
  }

  watcherRefCount = 0;

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  watcherReadyPromise = null;

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

export function onHistoryChange(callback: HistoryChangeCallback): void {
  historyChangeListeners.add(callback);
}

export function offHistoryChange(callback: HistoryChangeCallback): void {
  historyChangeListeners.delete(callback);
}

export function onSessionChange(callback: SessionChangeCallback): void {
  sessionChangeListeners.add(callback);
}

export function offSessionChange(callback: SessionChangeCallback): void {
  sessionChangeListeners.delete(callback);
}

export function onWorkflowChange(callback: WorkflowChangeCallback): void {
  workflowChangeListeners.add(callback);
}

export function offWorkflowChange(callback: WorkflowChangeCallback): void {
  workflowChangeListeners.delete(callback);
}
