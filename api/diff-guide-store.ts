import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CodexThreadSummary, DiffGuideSummary } from "./storage";

export interface DiffGuideRecord {
  sessionId: string;
  parentSessionId: string;
  requestId: string;
  projectRoot: string;
  prompt: string;
  model?: string | null;
  effort?: string | null;
  skillInstallChoice?: "local" | "global" | null;
  thread: CodexThreadSummary;
  turnId: string | null;
  status: "starting" | "generating" | "failed";
  error: string | null;
}

export function validateDiffGuideId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) {
    throw new Error("Invalid diff guide identifier");
  }
}

export class DiffGuideStore {
  private readyCache = new Map<string, string>();

  constructor(readonly codexHome: string) {}

  async prepare(): Promise<void> {
    await mkdir(await this.safePath(["sessions"]), { recursive: true });
  }

  directory(sessionId: string): string {
    validateDiffGuideId(sessionId);
    return join(this.codexHome, "codex-deck", "diff", "sessions", sessionId);
  }

  // App-owned directories cannot redirect file access through symbolic links.
  private async safePath(parts: string[]): Promise<string> {
    let path = await realpath(this.codexHome);
    for (const part of ["codex-deck", "diff", ...parts]) {
      path = join(path, part);
      try {
        if ((await lstat(path)).isSymbolicLink()) {
          throw new Error("Diff artifact symbolic links are not allowed");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return path;
  }

  async read(sessionId: string): Promise<DiffGuideRecord | null> {
    validateDiffGuideId(sessionId);
    try {
      const path = await this.safePath(["sessions", sessionId, "session.json"]);
      const record = JSON.parse(
        await readFile(path, "utf8"),
      ) as DiffGuideRecord;
      if (
        record.sessionId !== sessionId ||
        !record.parentSessionId ||
        !record.requestId ||
        !record.thread
      ) {
        throw new Error("Invalid diff session metadata");
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(record: DiffGuideRecord): Promise<void> {
    validateDiffGuideId(record.sessionId);
    const dir = await this.safePath(["sessions", record.sessionId]);
    await mkdir(dir, { recursive: true });
    await this.safePath(["sessions", record.sessionId, "session.json"]);
    const temp = join(dir, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(record, null, 2) + "\n", {
        flag: "wx",
      });
      await rename(temp, join(dir, "session.json"));
    } finally {
      await rm(temp, { force: true });
    }
  }

  async records(): Promise<DiffGuideRecord[]> {
    const dir = await this.safePath(["sessions"]);
    const entries = await readdir(dir, { withFileTypes: true }).catch(
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.read(entry.name);
          } catch {
            return null;
          }
        }),
    );
    return records.filter(
      (record): record is DiffGuideRecord => record !== null,
    );
  }

  async findRequest(requestId: string): Promise<DiffGuideRecord | null> {
    validateDiffGuideId(requestId);
    return (
      (await this.records()).find((record) => record.requestId === requestId) ??
      null
    );
  }

  async content(
    record: DiffGuideRecord,
    includeHtml = true,
  ): Promise<string | null> {
    const names = ["guide.json", "snapshot.json", "diff-tour.html"];
    try {
      const paths = await Promise.all(
        names.map((name) =>
          this.safePath(["sessions", record.sessionId, name]),
        ),
      );
      const stats = await Promise.all(paths.map((path) => stat(path)));
      // Snapshots contain both repository trees and can exceed the rendered
      // guide's size. Readiness depends on valid, complete artifacts, not size.
      if (stats.some((s) => !s.isFile() || s.size === 0)) return null;
      const fingerprint = stats
        .map((s) => `${s.mtimeMs}:${s.ctimeMs}:${s.size}`)
        .join("|");
      if (this.readyCache.get(record.sessionId) === fingerprint)
        return includeHtml ? readFile(paths[2], "utf8") : "ready";
      const [guideText, snapshotText, html] = await Promise.all(
        paths.map((path) => readFile(path, "utf8")),
      );
      const guide = JSON.parse(guideText);
      const snapshot = JSON.parse(snapshotText);
      const valid =
        guide &&
        snapshot &&
        guide.comparison &&
        Array.isArray(guide.steps) &&
        guide.steps.length > 0 &&
        isDeepStrictEqual(guide.comparison, snapshot.comparison) &&
        /<\/html>\s*$/i.test(html);
      // Cache only completed artifacts; partially written JSON will be re-read.
      if (valid) {
        if (this.readyCache.size >= 16)
          this.readyCache.delete(this.readyCache.keys().next().value!);
        this.readyCache.set(record.sessionId, fingerprint);
      }
      return valid ? html : null;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      )
        return null;
      throw error;
    }
  }

  async sourceSnapshot(record: DiffGuideRecord): Promise<unknown> {
    const path = await this.safePath([
      "sessions",
      record.sessionId,
      "snapshot.json",
    ]);
    return JSON.parse(await readFile(path, "utf8"));
  }

  async summary(record: DiffGuideRecord): Promise<DiffGuideSummary> {
    return {
      sessionId: record.sessionId,
      parentSessionId: record.parentSessionId,
      projectRoot: record.projectRoot,
      status: (await this.content(record, false)) ? "ready" : record.status,
      error: record.error,
    };
  }

  async remove(sessionId: string): Promise<void> {
    validateDiffGuideId(sessionId);
    const dir = await this.safePath(["sessions", sessionId]);
    await rm(dir, { recursive: true, force: true });
    this.readyCache.delete(sessionId);
  }
}
