import { randomUUID } from "node:crypto";
import { nativeRecord } from "./codex-native";
import type { ExtensionRpc } from "./codex-extensions";
import { CodexInputError } from "./codex-input-error";

/**
 * Native external-agent setup migration (`/import`), mirroring upstream
 * codex-rs/tui/src/external_agent_config_migration. One import may run at a
 * time per Deck process; progress is shared with every connected client.
 */

export const IMPORT_SOURCES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "cursor", label: "Cursor" },
] as const;
export const IMPORT_IN_PROGRESS_MESSAGE =
  "A previous external agent import is still running. Wait for it to finish before importing again.";

export interface ImportMigrationItem {
  itemType: string;
  description: string;
  cwd: string | null;
  details: Record<string, unknown> | null;
}
export interface ImportTypeResult {
  itemType: string;
  successes: {
    itemType: string;
    cwd: string | null;
    source: string | null;
    target: string | null;
    title: string | null;
  }[];
  failures: {
    itemType: string;
    failureStage: string;
    message: string;
    cwd: string | null;
    source: string | null;
  }[];
}
export interface ImportDetection {
  sources: { id: string; label: string; items: ImportMigrationItem[] }[];
  errors: string[];
}
export interface ImportRun {
  id: string;
  importId: string | null;
  source: string;
  sourceLabel: string;
  items: ImportMigrationItem[];
  remainingItemCount: number;
  results: ImportTypeResult[];
  status: "running" | "completed" | "failed";
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}
export interface ImportSnapshot {
  run: ImportRun | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseItem(value: unknown): ImportMigrationItem | null {
  const item = record(value);
  if (!item || typeof item.itemType !== "string") return null;
  return {
    itemType: item.itemType,
    description: typeof item.description === "string" ? item.description : "",
    cwd: text(item.cwd),
    details: record(item.details),
  };
}
function itemKey(item: ImportMigrationItem): string {
  return JSON.stringify([item.itemType, item.cwd ?? "", item.description]);
}
function parseResults(value: unknown): ImportTypeResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(record)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      itemType: String(entry.itemType ?? ""),
      successes: (Array.isArray(entry.successes) ? entry.successes : [])
        .map(record)
        .filter((row): row is Record<string, unknown> => Boolean(row))
        .map((row) => ({
          itemType: String(row.itemType ?? entry.itemType ?? ""),
          cwd: text(row.cwd),
          source: text(row.source),
          target: text(row.target),
          title: text(row.title),
        })),
      failures: (Array.isArray(entry.failures) ? entry.failures : [])
        .map(record)
        .filter((row): row is Record<string, unknown> => Boolean(row))
        .map((row) => ({
          itemType: String(row.itemType ?? entry.itemType ?? ""),
          failureStage: String(row.failureStage ?? ""),
          message: String(row.message ?? "Import failed"),
          cwd: text(row.cwd),
          source: text(row.source),
        })),
    }));
}

export class CodexImportManager {
  private run: ImportRun | null = null;

  constructor(
    private readonly rpc: ExtensionRpc,
    private readonly changed: () => void,
  ) {}

  private isRunning(): boolean {
    return this.run?.status === "running";
  }

  snapshot(): ImportSnapshot {
    return { run: this.run };
  }

  observe(method: string, params: unknown): boolean {
    if (
      method !== "externalAgentConfig/import/progress" &&
      method !== "externalAgentConfig/import/completed"
    )
      return false;
    const value = record(params);
    const importId = text(value?.importId);
    const run = this.run;
    // Imports started elsewhere (Codex CLI on a shared daemon) are ignored;
    // a notification may arrive before this run learns its import ID.
    if (
      run &&
      run.status === "running" &&
      importId &&
      (run.importId === null || run.importId === importId)
    ) {
      run.importId = importId;
      run.results = parseResults(value?.itemTypeResults);
      if (method === "externalAgentConfig/import/completed") {
        run.status = "completed";
        run.completedAt = Date.now();
      }
      this.changed();
    }
    return true;
  }

  async detect(cwd?: string | null): Promise<ImportDetection> {
    const detection: ImportDetection = { sources: [], errors: [] };
    for (const source of IMPORT_SOURCES) {
      try {
        const result = nativeRecord(
          await this.rpc("externalAgentConfig/detect", {
            includeHome: true,
            cwds: cwd ? [cwd] : null,
            migrationSource: source.id,
          }),
        );
        const items = (Array.isArray(result.items) ? result.items : [])
          .map(parseItem)
          .filter((item): item is ImportMigrationItem => Boolean(item));
        if (items.length)
          detection.sources.push({ id: source.id, label: source.label, items });
      } catch (reason) {
        detection.errors.push(
          `${source.label}: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }
    }
    return detection;
  }

  async start(
    sourceId: unknown,
    selected: unknown,
    cwd?: string | null,
  ): Promise<ImportSnapshot> {
    if (this.isRunning()) throw new CodexInputError(IMPORT_IN_PROGRESS_MESSAGE);
    const source = IMPORT_SOURCES.find((entry) => entry.id === sourceId);
    if (!source) throw new CodexInputError("Unsupported import source.");
    if (!Array.isArray(selected) || !selected.length)
      throw new CodexInputError("Choose at least one item to import.");
    const requested = selected.map(parseItem);
    if (requested.some((item) => !item))
      throw new CodexInputError("Invalid import item.");
    // Only import items the server detected; never forward client-built paths.
    const detected =
      (await this.detect(cwd)).sources.find((entry) => entry.id === source.id)
        ?.items ?? [];
    const byKey = new Map(detected.map((item) => [itemKey(item), item]));
    const items = (requested as ImportMigrationItem[]).map((item) =>
      byKey.get(itemKey(item)),
    );
    if (items.some((item) => !item))
      throw new CodexInputError(
        "Selected import items are no longer available. Run /import again.",
      );
    if (this.isRunning()) throw new CodexInputError(IMPORT_IN_PROGRESS_MESSAGE);
    const run: ImportRun = {
      id: randomUUID(),
      importId: null,
      source: source.id,
      sourceLabel: source.label,
      items: items as ImportMigrationItem[],
      remainingItemCount: Math.max(0, detected.length - items.length),
      results: [],
      status: "running",
      error: null,
      startedAt: Date.now(),
      completedAt: null,
    };
    this.run = run;
    this.changed();
    try {
      const response = nativeRecord(
        await this.rpc("externalAgentConfig/import", {
          migrationItems: run.items,
          source: "codex-deck",
          providerId: source.id,
          migrationSource: source.id,
        }),
      );
      if (typeof response.importId !== "string")
        throw new Error("Invalid externalAgentConfig/import response");
      if (run.importId === null) run.importId = response.importId;
    } catch (reason) {
      run.status = "failed";
      run.error = `Import failed: ${reason instanceof Error ? reason.message : String(reason)}`;
      run.completedAt = Date.now();
    }
    this.changed();
    return this.snapshot();
  }

  /** Clears a finished run so the next `/import` starts fresh. */
  dismiss(id: unknown): ImportSnapshot {
    if (this.run && this.run.status !== "running" && this.run.id === id) {
      this.run = null;
      this.changed();
    }
    return this.snapshot();
  }
}
