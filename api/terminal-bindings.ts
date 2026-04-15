import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { getCodexDir } from "./storage";
import type {
  TerminalBindingResponse,
  TerminalSessionRoleSummary,
} from "./storage";

const TERMINAL_BINDINGS_DIRNAME = "codex-deck/terminal/bindings";
const TERMINAL_SESSION_INDEX_DIRNAME = "codex-deck/terminal/session-index";
const WORKFLOW_SESSION_INDEX_DIRNAME = "codex-deck/workflows/session-index";

type JsonObject = Record<string, unknown>;

interface TerminalBindingRecord {
  terminalId: string;
  sessionId: string;
  updatedAt: string;
}

const terminalBindingChangeListeners = new Set<() => void>();

export class TerminalBindingConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TerminalBindingConflictError";
  }
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

function getTerminalBindingsDir(codexHome?: string | null): string {
  return join(resolveCodexHome(codexHome), TERMINAL_BINDINGS_DIRNAME);
}

function getTerminalSessionIndexDir(codexHome?: string | null): string {
  return join(resolveCodexHome(codexHome), TERMINAL_SESSION_INDEX_DIRNAME);
}

function getWorkflowSessionIndexDir(codexHome?: string | null): string {
  return join(resolveCodexHome(codexHome), WORKFLOW_SESSION_INDEX_DIRNAME);
}

function getTerminalBindingPath(
  terminalId: string,
  codexHome?: string | null,
): string {
  return join(getTerminalBindingsDir(codexHome), `${terminalId}.json`);
}

function getTerminalSessionIndexPath(
  sessionId: string,
  codexHome?: string | null,
): string {
  return join(getTerminalSessionIndexDir(codexHome), `${sessionId}.json`);
}

function getWorkflowSessionIndexPath(
  sessionId: string,
  codexHome?: string | null,
): string {
  return join(getWorkflowSessionIndexDir(codexHome), `${sessionId}.json`);
}

function normalizeTerminalBindingRecord(value: unknown): TerminalBindingRecord | null {
  const record = asRecord(value);
  const terminalId = asString(record.terminalId);
  const sessionId = asString(record.sessionId);
  const updatedAt = asString(record.updatedAt) || new Date().toISOString();
  if (!terminalId || !sessionId) {
    return null;
  }
  return {
    terminalId,
    sessionId,
    updatedAt,
  };
}

async function readJsonFile(path: string): Promise<JsonObject> {
  const text = await readFile(path, "utf-8");
  return asRecord(JSON.parse(text));
}

async function readOptionalBindingRecord(path: string): Promise<TerminalBindingRecord | null> {
  try {
    return normalizeTerminalBindingRecord(await readJsonFile(path));
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    ) {
      return null;
    }
    throw error;
  }
}

async function writeTextFileAtomic(path: string, text: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(tempPath, text, "utf-8");
  await rename(tempPath, path);
}

async function ensureTerminalBindingDirs(codexHome?: string | null): Promise<void> {
  await Promise.all([
    mkdir(getTerminalBindingsDir(codexHome), { recursive: true }),
    mkdir(getTerminalSessionIndexDir(codexHome), { recursive: true }),
  ]);
}

function normalizeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function emitTerminalBindingChange(): void {
  for (const listener of terminalBindingChangeListeners) {
    listener();
  }
}

async function removeTerminalBindingIfMatches(
  terminalId: string,
  expectedSessionId: string,
  codexHome?: string | null,
): Promise<boolean> {
  const path = getTerminalBindingPath(terminalId, codexHome);
  const existing = await readOptionalBindingRecord(path);
  if (!existing || existing.sessionId !== expectedSessionId) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

async function removeSessionIndexIfMatches(
  sessionId: string,
  expectedTerminalId: string,
  codexHome?: string | null,
): Promise<boolean> {
  const path = getTerminalSessionIndexPath(sessionId, codexHome);
  const existing = await readOptionalBindingRecord(path);
  if (!existing || existing.terminalId !== expectedTerminalId) {
    return false;
  }
  await rm(path, { force: true });
  return true;
}

async function hasWorkflowSessionBinding(
  sessionId: string,
  codexHome?: string | null,
): Promise<boolean> {
  const path = getWorkflowSessionIndexPath(sessionId, codexHome);
  if (!existsSync(path)) {
    return false;
  }

  try {
    await readFile(path, "utf-8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function onTerminalBindingChange(listener: () => void): () => void {
  terminalBindingChangeListeners.add(listener);
  return () => {
    terminalBindingChangeListeners.delete(listener);
  };
}

export async function getTerminalBinding(
  terminalId: string,
  codexHome?: string | null,
): Promise<TerminalBindingResponse> {
  const normalizedTerminalId = normalizeId(terminalId, "terminal id");
  const binding = await readOptionalBindingRecord(
    getTerminalBindingPath(normalizedTerminalId, codexHome),
  );
  return {
    terminalId: normalizedTerminalId,
    boundSessionId: binding?.sessionId ?? null,
  };
}

export async function getTerminalBindingsByTerminalIds(
  terminalIds: string[],
  codexHome?: string | null,
): Promise<Record<string, string | null>> {
  const normalizedTerminalIds = [
    ...new Set(
      terminalIds
        .map((terminalId) => terminalId.trim())
        .filter((terminalId) => terminalId.length > 0),
    ),
  ];
  const mappings = await Promise.all(
    normalizedTerminalIds.map(async (terminalId) => {
      const binding = await readOptionalBindingRecord(
        getTerminalBindingPath(terminalId, codexHome),
      );
      return [terminalId, binding?.sessionId ?? null] as const;
    }),
  );

  return Object.fromEntries(mappings);
}

export function getAllTerminalBindingsSync(
  codexHome?: string | null,
): Record<string, string> {
  const bindingsDir = getTerminalBindingsDir(codexHome);
  if (!existsSync(bindingsDir)) {
    return {};
  }

  const mappings: Array<readonly [string, string]> = [];
  for (const entry of readdirSync(bindingsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const record = normalizeTerminalBindingRecord(
        JSON.parse(readFileSync(join(bindingsDir, entry.name), "utf-8")),
      );
      if (record) {
        mappings.push([record.terminalId, record.sessionId] as const);
      }
    } catch {
      // Ignore unreadable binding files during startup reconciliation.
    }
  }

  return Object.fromEntries(mappings);
}

export async function clearTerminalBinding(
  terminalId: string,
  codexHome?: string | null,
): Promise<TerminalBindingResponse> {
  const normalizedTerminalId = normalizeId(terminalId, "terminal id");
  const bindingPath = getTerminalBindingPath(normalizedTerminalId, codexHome);
  const existing = await readOptionalBindingRecord(bindingPath);

  let changed = false;
  if (existing) {
    await rm(bindingPath, { force: true });
    changed = true;
    await removeSessionIndexIfMatches(
      existing.sessionId,
      normalizedTerminalId,
      codexHome,
    );
  }

  if (changed) {
    emitTerminalBindingChange();
  }

  return {
    terminalId: normalizedTerminalId,
    boundSessionId: null,
  };
}

export async function setTerminalBinding(
  terminalId: string,
  sessionId: string | null,
  codexHome?: string | null,
): Promise<TerminalBindingResponse> {
  const normalizedTerminalId = normalizeId(terminalId, "terminal id");
  const normalizedSessionId = sessionId?.trim() ?? "";

  if (!normalizedSessionId) {
    return clearTerminalBinding(normalizedTerminalId, codexHome);
  }

  if (await hasWorkflowSessionBinding(normalizedSessionId, codexHome)) {
    throw new TerminalBindingConflictError(
      "Session is already bound to a workflow and cannot be bound to a terminal chat.",
    );
  }

  await ensureTerminalBindingDirs(codexHome);

  const currentTerminalBinding = await readOptionalBindingRecord(
    getTerminalBindingPath(normalizedTerminalId, codexHome),
  );
  const currentSessionBinding = await readOptionalBindingRecord(
    getTerminalSessionIndexPath(normalizedSessionId, codexHome),
  );

  if (
    currentSessionBinding &&
    currentSessionBinding.terminalId !== normalizedTerminalId
  ) {
    await removeTerminalBindingIfMatches(
      currentSessionBinding.terminalId,
      normalizedSessionId,
      codexHome,
    );
  }

  if (
    currentTerminalBinding &&
    currentTerminalBinding.sessionId !== normalizedSessionId
  ) {
    await removeSessionIndexIfMatches(
      currentTerminalBinding.sessionId,
      normalizedTerminalId,
      codexHome,
    );
  }

  const nextBinding: TerminalBindingRecord = {
    terminalId: normalizedTerminalId,
    sessionId: normalizedSessionId,
    updatedAt: new Date().toISOString(),
  };

  const payload = JSON.stringify(nextBinding, null, 2) + "\n";
  await writeTextFileAtomic(
    getTerminalBindingPath(normalizedTerminalId, codexHome),
    payload,
  );
  await writeTextFileAtomic(
    getTerminalSessionIndexPath(normalizedSessionId, codexHome),
    payload,
  );

  emitTerminalBindingChange();

  return {
    terminalId: normalizedTerminalId,
    boundSessionId: normalizedSessionId,
  };
}

export async function getTerminalSessionRoles(
  sessionIds: string[],
  codexHome?: string | null,
): Promise<TerminalSessionRoleSummary[]> {
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

  const roles = await Promise.all(
    normalizedSessionIds.map(async (sessionId) => {
      const record = await readOptionalBindingRecord(
        getTerminalSessionIndexPath(sessionId, codexHome),
      );
      if (!record) {
        return null;
      }
      return {
        sessionId,
        role: "terminal",
        terminalId: record.terminalId,
      } satisfies TerminalSessionRoleSummary;
    }),
  );

  return roles.filter(
    (entry): entry is TerminalSessionRoleSummary => Boolean(entry),
  );
}
