import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type {
  SessionContentSearchCommand,
  SessionContentSearchResponse,
  SessionSearchFileEntry,
} from "./storage";

const SEARCH_COMMANDS: readonly SessionContentSearchCommand[] = [
  "rg",
  "ag",
  "ack",
  "grep",
];
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export class SessionSearchCommandUnavailableError extends Error {
  constructor() {
    super("Deep search requires rg, ag, ack, or grep on PATH.");
    this.name = "SessionSearchCommandUnavailableError";
  }
}

interface SearchProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type IsExecutable = (filePath: string) => Promise<boolean>;
type ExecuteSearchProcess = (
  command: SessionContentSearchCommand,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<SearchProcessResult>;

interface SearchSessionContentOptions {
  query: string;
  searchRoot: string;
  sessionFiles: SessionSearchFileEntry[];
  signal?: AbortSignal;
}

interface SearchSessionContentDependencies {
  pathValue?: string;
  isExecutable?: IsExecutable;
  executeSearchProcess?: ExecuteSearchProcess;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectSessionSearchCommand(
  pathValue: string = process.env.PATH ?? "",
  isExecutable: IsExecutable = isExecutableFile,
): Promise<SessionContentSearchCommand | null> {
  const pathDirectories = pathValue
    .split(delimiter)
    .map((entry) => entry || process.cwd());

  for (const command of SEARCH_COMMANDS) {
    for (const directory of pathDirectories) {
      if (await isExecutable(join(directory, command))) {
        return command;
      }
    }
  }

  return null;
}

export function buildSessionSearchArgs(
  command: SessionContentSearchCommand,
  query: string,
): string[] {
  switch (command) {
    case "rg":
      return [
        "--files-with-matches",
        "--fixed-strings",
        "--ignore-case",
        "--glob",
        "*.jsonl",
        "--",
        query,
        ".",
      ];
    case "ag":
      return [
        "--files-with-matches",
        "--literal",
        "--ignore-case",
        "--file-search-regex",
        "\\.jsonl$",
        "--",
        query,
        ".",
      ];
    case "ack":
      return [
        "--noenv",
        "--files-with-matches",
        "--literal",
        "--ignore-case",
        "--type-set=codexsession:ext:jsonl",
        "--type=codexsession",
        "--",
        query,
        ".",
      ];
    case "grep":
      return ["-R", "-l", "-F", "-i", "--include=*.jsonl", "--", query, "."];
  }
}

function appendOutput(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxBytes: number,
): number {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return currentBytes;
  }
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  return currentBytes + Math.min(chunk.length, remaining);
}

async function executeSearchProcess(
  command: SessionContentSearchCommand,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<SearchProcessResult> {
  if (signal?.aborted) {
    throw new Error("Deep search was cancelled.");
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
    };
    const finishWithError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => {
      child.kill();
      finishWithError(new Error("Deep search was cancelled."));
    };
    const timeout = setTimeout(() => {
      child.kill();
      finishWithError(new Error("Deep search timed out."));
    }, SEARCH_TIMEOUT_MS);

    signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendOutput(
        stdoutChunks,
        chunk,
        stdoutBytes,
        MAX_STDOUT_BYTES,
      );
      if (stdoutBytes >= MAX_STDOUT_BYTES) {
        child.kill();
        finishWithError(new Error("Deep search returned too many matches."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendOutput(
        stderrChunks,
        chunk,
        stderrBytes,
        MAX_STDERR_BYTES,
      );
    });
    child.on("error", (error) => finishWithError(error));
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: exitCode ?? 2,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

export async function searchSessionContent(
  options: SearchSessionContentOptions,
  dependencies: SearchSessionContentDependencies = {},
): Promise<SessionContentSearchResponse> {
  const command = await detectSessionSearchCommand(
    dependencies.pathValue,
    dependencies.isExecutable,
  );
  if (!command) {
    throw new SessionSearchCommandUnavailableError();
  }

  const searchRoot = resolve(options.searchRoot);
  if (!(await directoryExists(searchRoot))) {
    return { query: options.query, command, sessionIds: [] };
  }

  const result = await (
    dependencies.executeSearchProcess ?? executeSearchProcess
  )(
    command,
    buildSessionSearchArgs(command, options.query),
    searchRoot,
    options.signal,
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    const details = result.stderr.trim();
    throw new Error(
      details
        ? `Deep search with ${command} failed: ${details}`
        : `Deep search with ${command} failed with exit code ${result.exitCode}.`,
    );
  }

  const sessionIdByPath = new Map(
    options.sessionFiles.map(({ sessionId, filePath }) => [
      resolve(filePath),
      sessionId,
    ]),
  );
  const matchedSessionIds = new Set<string>();
  for (const outputPath of result.stdout.split(/\r?\n/u)) {
    const trimmedPath = outputPath.trim();
    if (!trimmedPath) {
      continue;
    }
    const absolutePath = isAbsolute(trimmedPath)
      ? resolve(trimmedPath)
      : resolve(searchRoot, trimmedPath);
    const sessionId = sessionIdByPath.get(absolutePath);
    if (sessionId) {
      matchedSessionIds.add(sessionId);
    }
  }

  return {
    query: options.query,
    command,
    sessionIds: [...matchedSessionIds],
  };
}
