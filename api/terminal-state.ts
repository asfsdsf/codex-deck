import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { getCodexDir } from "./storage";
import type { TerminalSummary } from "./storage";

const TERMINAL_STATE_DIRNAME = "codex-deck/terminal/state";

type JsonObject = Record<string, unknown>;

export interface PersistedTerminalStateRecord {
  terminalId: string;
  cwd: string;
  shell: string;
  firstCommand: string | null;
  timestamp: number;
  updatedAt: string;
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

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function getTerminalStateDir(codexHome?: string | null): string {
  return join(resolveCodexHome(codexHome), TERMINAL_STATE_DIRNAME);
}

function getTerminalStatePath(
  terminalId: string,
  codexHome?: string | null,
): string {
  return join(getTerminalStateDir(codexHome), `${terminalId}.json`);
}

function normalizePersistedTerminalStateRecord(
  value: unknown,
): PersistedTerminalStateRecord | null {
  const record = asRecord(value);
  const terminalId = asString(record.terminalId);
  const cwd = asString(record.cwd);
  const shell = asString(record.shell);
  const timestamp = asNumber(record.timestamp) ?? Date.now();
  const updatedAt = asString(record.updatedAt) ?? new Date().toISOString();
  const firstCommand = asString(record.firstCommand);

  if (!terminalId || !cwd || !shell) {
    return null;
  }

  return {
    terminalId,
    cwd,
    shell,
    firstCommand,
    timestamp,
    updatedAt,
  };
}

async function writeTextFileAtomic(path: string, text: string): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(tempPath, text, "utf-8");
  await rename(tempPath, path);
}

const terminalStateOperationQueues = new Map<string, Promise<void>>();

function queueTerminalStateOperation(
  terminalId: string,
  operation: () => Promise<void>,
): Promise<void> {
  const previous =
    terminalStateOperationQueues.get(terminalId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const cleanupPromise = next.finally(() => {
    if (terminalStateOperationQueues.get(terminalId) === cleanupPromise) {
      terminalStateOperationQueues.delete(terminalId);
    }
  });
  terminalStateOperationQueues.set(terminalId, cleanupPromise);
  return cleanupPromise;
}

export async function persistTerminalState(
  summary: TerminalSummary,
  codexHome?: string | null,
): Promise<void> {
  const terminalId = summary.terminalId.trim();
  if (!terminalId) {
    return;
  }

  await queueTerminalStateOperation(terminalId, async () => {
    await mkdir(getTerminalStateDir(codexHome), { recursive: true });
    await writeTextFileAtomic(
      getTerminalStatePath(terminalId, codexHome),
      JSON.stringify(
        {
          terminalId,
          cwd: summary.cwd,
          shell: summary.shell,
          firstCommand: summary.firstCommand,
          timestamp: summary.timestamp,
          updatedAt: new Date().toISOString(),
        } satisfies PersistedTerminalStateRecord,
        null,
        2,
      ),
    );
  });
}

export async function removeTerminalState(
  terminalId: string,
  codexHome?: string | null,
): Promise<void> {
  const normalizedTerminalId = terminalId.trim();
  if (!normalizedTerminalId) {
    return;
  }

  await queueTerminalStateOperation(normalizedTerminalId, async () => {
    await rm(getTerminalStatePath(normalizedTerminalId, codexHome), {
      force: true,
    });
  });
}

export function listPersistedTerminalStatesSync(
  codexHome?: string | null,
): PersistedTerminalStateRecord[] {
  const stateDir = getTerminalStateDir(codexHome);
  if (!existsSync(stateDir)) {
    return [];
  }

  const records: PersistedTerminalStateRecord[] = [];
  for (const entry of readdirSync(stateDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const text = readFileSync(join(stateDir, entry.name), "utf-8");
      const record = normalizePersistedTerminalStateRecord(JSON.parse(text));
      if (record) {
        records.push(record);
      }
    } catch {
      // Ignore unreadable state files during startup rehydration.
    }
  }

  return records.sort((left, right) => right.timestamp - left.timestamp);
}

export function removeTerminalStateSync(
  terminalId: string,
  codexHome?: string | null,
): void {
  const normalizedTerminalId = terminalId.trim();
  if (!normalizedTerminalId) {
    return;
  }

  try {
    const statePath = getTerminalStatePath(normalizedTerminalId, codexHome);
    if (existsSync(statePath)) {
      rmSync(statePath, { force: true });
    }
  } catch {
    // Ignore best-effort startup cleanup failures.
  }
}
