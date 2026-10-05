import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { DiffGuideSourceResponse } from "./storage";

const run = promisify(execFile);
const modes = new Set(["100644", "100755", "120000", "160000"]);
interface Entry {
  mode: string;
  oid: string;
}
interface Row {
  kind: string;
  text?: string;
  old?: number | null;
  new?: number | null;
  oldStart?: number;
  newStart?: number;
  count?: number;
  lines?: Row[];
}
interface File {
  path: string;
  oldPath: string;
  oldMode: string;
  newMode: string;
  rows: Row[];
  lineCount: number;
  oldLineCount: number;
  newEndsWithNewline: boolean;
  notice?: string;
}
interface Snapshot {
  schemaVersion: number;
  sourceMode: string;
  objectFormat: "sha1" | "sha256";
  comparison: {
    base: string | null;
    repositoryId: string;
    fingerprint: string;
  };
  left: Record<string, Entry>;
  right: Record<string, Entry>;
  files: Record<string, File>;
}
export class DiffGuideSourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 = 409,
  ) {
    super(message);
  }
}
function fail(message: string): never {
  throw new DiffGuideSourceError(message);
}
function validPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    !!path &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
// Match Python's sorted, ASCII JSON used by the capture fingerprint.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) {
    const keys = Object.keys(value).sort((a, b) => {
      const x = Array.from(a, (c) => c.codePointAt(0)!);
      const y = Array.from(b, (c) => c.codePointAt(0)!);
      for (let i = 0; i < Math.min(x.length, y.length); i++)
        if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    });
    return `{${keys.map((key) => `${canonical(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
function snapshotOf(value: unknown): Snapshot {
  if (
    !object(value) ||
    value.schemaVersion !== 3 ||
    !["embedded", "project"].includes(String(value.sourceMode)) ||
    !["sha1", "sha256"].includes(String(value.objectFormat)) ||
    !object(value.comparison) ||
    !object(value.left) ||
    !object(value.right) ||
    !object(value.files)
  )
    fail("Unsupported source snapshot. Regenerate the diff guide.");
  const length = value.objectFormat === "sha1" ? 40 : 64;
  const oid = (v: unknown) =>
    typeof v === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(v);
  if (value.comparison.base !== null && !oid(value.comparison.base))
    fail("Invalid baseline commit");
  for (const side of [value.left, value.right]) {
    for (const [path, entry] of Object.entries(side)) {
      if (
        !validPath(path) ||
        !object(entry) ||
        !modes.has(String(entry.mode)) ||
        !oid(entry.oid)
      )
        fail("Invalid source tree entry");
    }
  }
  for (const [path, file] of Object.entries(value.files)) {
    if (
      !validPath(path) ||
      !object(file) ||
      file.path !== path ||
      !validPath(file.oldPath) ||
      !Array.isArray(file.rows) ||
      !Number.isSafeInteger(file.lineCount) ||
      Number(file.lineCount) < 0 ||
      !Number.isSafeInteger(file.oldLineCount) ||
      Number(file.oldLineCount) < 0
    )
      fail("Invalid captured diff file");
  }
  const payload: Record<string, unknown> = {};
  for (const key of [
    "schemaVersion",
    "sourceMode",
    "comparison",
    "left",
    "right",
    "repositoryName",
    "repositoryUrl",
    "objectFormat",
    "rightCommitted",
  ])
    payload[key] = value[key];
  payload.comparison = Object.fromEntries(
    Object.entries(value.comparison).filter(([key]) => key !== "fingerprint"),
  );
  if (value.sourceMode === "project") payload.files = value.files;
  if (
    createHash("sha256").update(canonical(payload)).digest("hex") !==
    value.comparison.fingerprint
  )
    fail("Snapshot fingerprint does not match its contents");
  return value as unknown as Snapshot;
}
async function git(repo: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await run("git", ["-C", repo, ...args], {
    encoding: "buffer",
    timeout: 30_000,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}
function oidOf(content: Buffer, format: "sha1" | "sha256"): string {
  return createHash(format)
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}
function textLines(content: Buffer): string[] {
  if (content.includes(0)) fail("Binary source is unavailable");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      content,
    );
  } catch {
    return fail("Non-UTF-8 source is unavailable");
  }
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}
export function reconstructDiffGuideSource(file: File, before: Buffer): Buffer {
  if (file.notice) fail("Text source is unavailable for this file");
  const old = textLines(before);
  const lines: string[] = [];
  let cursor = 0;
  for (const row of file.rows) {
    if (!object(row)) fail("Invalid diff row");
    if (row.kind === "hunk") continue;
    if (row.kind === "gap") {
      const start = row.oldStart ?? row.lines?.[0]?.old;
      const newStart = row.newStart ?? row.lines?.[0]?.new;
      const count = row.count ?? row.lines?.length;
      if (
        start !== cursor + 1 ||
        newStart !== lines.length + 1 ||
        !Number.isSafeInteger(count) ||
        !count ||
        count < 1 ||
        cursor + count > old.length
      )
        fail("Invalid unchanged source range");
      for (const line of old.slice(cursor, cursor + count)) lines.push(line);
      cursor += count;
      continue;
    }
    if (
      !["context", "add", "del"].includes(row.kind) ||
      typeof row.text !== "string"
    )
      fail("Invalid diff row");
    if (row.kind !== "add") {
      if (
        row.old !== cursor + 1 ||
        cursor >= old.length ||
        row.text !== old[cursor]
      )
        fail("Diff does not match baseline source");
      cursor++;
    }
    if (row.kind !== "del") {
      if (row.new !== lines.length + 1)
        fail("Invalid current source numbering");
      lines.push(row.text);
    }
  }
  if (
    cursor !== old.length ||
    old.length !== file.oldLineCount ||
    lines.length !== file.lineCount ||
    typeof file.newEndsWithNewline !== "boolean"
  )
    fail("Incomplete source reconstruction");
  return Buffer.from(lines.join("\n") + (file.newEndsWithNewline ? "\n" : ""));
}
export async function readDiffGuideSource(
  projectRoot: string,
  value: unknown,
  input: {
    path: string;
    side: "left" | "right";
    start: number;
    limit: number;
  },
): Promise<DiffGuideSourceResponse> {
  if (
    !validPath(input.path) ||
    !["left", "right"].includes(input.side) ||
    !Number.isSafeInteger(input.start) ||
    input.start < 1 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1000
  )
    throw new DiffGuideSourceError("Invalid source range or path", 400);
  const snapshot = snapshotOf(value);
  const entry = snapshot[input.side][input.path];
  if (!entry)
    throw new DiffGuideSourceError(
      "Source file is not in the captured comparison",
      404,
    );
  if (entry.mode === "160000") fail("Submodule gitlinks have no text source");
  const common = (await git(projectRoot, "rev-parse", "--git-common-dir"))
    .toString()
    .trim();
  const identity = createHash("sha256")
    .update(await realpath(resolve(projectRoot, common)))
    .digest("hex");
  if (identity !== snapshot.comparison.repositoryId)
    fail("Origin repository does not match the captured repository");
  const base = snapshot.comparison.base;
  if (base) {
    try {
      await git(projectRoot, "cat-file", "-e", `${base}^{commit}`);
    } catch {
      throw new DiffGuideSourceError(
        `Baseline commit ${base} is unavailable`,
        404,
      );
    }
  }
  const baseline = async (path: string): Promise<Buffer> => {
    const original = snapshot.left[path];
    if (!base || !original || original.mode === "160000")
      fail("Baseline source is unavailable");
    let content: Buffer;
    try {
      content = await git(projectRoot, "show", `${base}:${path}`);
    } catch {
      throw new DiffGuideSourceError(
        `Baseline source ${path} is unavailable`,
        404,
      );
    }
    if (oidOf(content, snapshot.objectFormat) !== original.oid)
      fail("Baseline source does not match its captured object ID");
    return content;
  };
  const file = input.side === "right" ? snapshot.files[input.path] : undefined;
  const content = file
    ? reconstructDiffGuideSource(
        file,
        file.oldMode === "000000"
          ? Buffer.alloc(0)
          : await baseline(file.oldPath),
      )
    : await baseline(input.path);
  if (oidOf(content, snapshot.objectFormat) !== entry.oid)
    fail("Reconstructed source does not match its captured object ID");
  const all = textLines(content);
  if (input.start > Math.max(1, all.length))
    throw new DiffGuideSourceError("Source range is out of bounds", 400);
  const lines: string[] = [];
  let bytes = 0;
  for (const line of all.slice(
    input.start - 1,
    input.start - 1 + input.limit,
  )) {
    const size = Buffer.byteLength(JSON.stringify(line)) + 1;
    if (bytes + size > 1024 * 1024) {
      if (!lines.length)
        throw new DiffGuideSourceError(
          "Source line exceeds the 1 MiB response limit",
          413,
        );
      break;
    }
    lines.push(line);
    bytes += size;
  }
  const next = input.start + lines.length;
  return {
    path: input.path,
    side: input.side,
    lineStart: input.start,
    lines,
    totalLines: all.length,
    nextLine: next <= all.length ? next : null,
  };
}
