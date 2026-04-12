import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import type {
  TerminalSnapshotResponse,
  TerminalStreamEvent,
  TerminalSummary,
} from "./storage";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_BUFFERED_EVENTS = 2000;
const MAX_OUTPUT_CHARS = 1_000_000;

type TerminalListener = (event: TerminalStreamEvent) => void;
type TerminalSummaryListener = (terminals: TerminalSummary[]) => void;
type TerminalEventWithoutSeq = {
  [K in TerminalStreamEvent["type"]]: Omit<
    Extract<TerminalStreamEvent, { type: K }>,
    "seq"
  >;
}[TerminalStreamEvent["type"]];

export interface LocalTerminalEventBatch {
  events: TerminalStreamEvent[];
  requiresReset: boolean;
}

export interface LocalTerminalManager {
  listTerminals: () => TerminalSummary[];
  createTerminal: (cwd?: string) => TerminalSnapshotResponse;
  closeTerminal: (terminalId: string) => Promise<boolean>;
  getSnapshot: (terminalId: string) => TerminalSnapshotResponse | null;
  restart: (terminalId: string) => TerminalSnapshotResponse | null;
  writeInput: (terminalId: string, input: string) => void;
  resize: (terminalId: string, cols: number, rows: number) => void;
  interrupt: (terminalId: string) => void;
  getEventsSince: (
    terminalId: string,
    fromSeq: number,
  ) => LocalTerminalEventBatch | null;
  subscribeTerminal: (
    terminalId: string,
    listener: TerminalListener,
  ) => () => void;
  subscribeTerminals: (listener: TerminalSummaryListener) => () => void;
  dispose: () => Promise<void>;
  getWriteOwnerId: (terminalId: string) => string | null;
  claimWrite: (terminalId: string, clientId: string) => void;
  releaseWrite: (terminalId: string, clientId: string) => void;
  isWriteOwner: (terminalId: string, clientId: string) => boolean;
}

interface TerminalProcessAdapter {
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: () => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  interrupt: () => void;
  kill: () => void;
}

interface CreatedTerminalProcess {
  process: TerminalProcessAdapter;
  shell: string;
  startupNotice: string | null;
}

interface TerminalInstanceSnapshot {
  terminalId: string;
  cwd: string;
  shell: string;
  output: string;
  seq: number;
  running: boolean;
  writeOwnerId: string | null;
  timestamp: number;
}

class TerminalInstance {
  private terminalProcess: TerminalProcessAdapter | null = null;
  private readonly listeners = new Set<TerminalListener>();
  private readonly env: Record<string, string>;
  private shell: string;
  private running = false;
  private seq = 0;
  private output = "";
  private bufferedEvents: TerminalStreamEvent[] = [];
  private writeOwnerId: string | null = null;
  private removed = false;
  private firstCommand: string | null = null;
  private pendingFirstCommandInput = "";

  public constructor(
    public readonly terminalId: string,
    public readonly cwd: string,
    private readonly timestamp: number,
    private readonly onStateChange: () => void,
    private readonly onExitCleanup: (terminalId: string) => void,
  ) {
    this.shell = resolveShell();
    this.env = normalizeEnv(process.env);
    this.start();
  }

  public getSummary(): TerminalSummary {
    const project = this.cwd;
    const projectName = basename(project) || project;
    const display = basename(this.cwd) || this.cwd;
    return {
      id: this.terminalId,
      terminalId: this.terminalId,
      display,
      firstCommand: this.firstCommand,
      timestamp: this.timestamp,
      project,
      projectName,
      cwd: this.cwd,
      shell: this.shell,
      running: this.running,
    };
  }

  public getSnapshot(): TerminalSnapshotResponse {
    return {
      id: this.terminalId,
      terminalId: this.terminalId,
      running: this.running,
      cwd: this.cwd,
      shell: this.shell,
      output: this.output,
      seq: this.seq,
      writeOwnerId: this.writeOwnerId,
    };
  }

  public restart(): TerminalSnapshotResponse {
    const processHandle = this.terminalProcess;
    this.terminalProcess = null;
    this.running = false;
    this.writeOwnerId = null;
    this.output = "";
    this.publish({
      terminalId: this.terminalId,
      type: "reset",
      output: "",
      running: false,
    });
    this.publish({
      terminalId: this.terminalId,
      type: "ownership",
      writeOwnerId: null,
    });

    if (processHandle) {
      try {
        processHandle.kill();
      } catch {
        // Ignore terminal kill failures during restart.
      }
    }

    this.start();
    this.onStateChange();
    return this.getSnapshot();
  }

  public writeInput(input: string): void {
    if (input.length === 0) {
      return;
    }
    this.captureFirstCommand(input);
    this.terminalProcess?.write(input);
  }

  public resize(cols: number, rows: number): void {
    this.terminalProcess?.resize(cols, rows);
  }

  public interrupt(): void {
    this.terminalProcess?.interrupt();
  }

  public getEventsSince(fromSeq: number): LocalTerminalEventBatch {
    const normalizedFromSeq = Number.isFinite(fromSeq)
      ? Math.max(0, Math.floor(fromSeq))
      : 0;

    if (this.bufferedEvents.length === 0) {
      return { events: [], requiresReset: false };
    }

    const oldestSeq = this.bufferedEvents[0]?.seq ?? 0;
    if (normalizedFromSeq > 0 && normalizedFromSeq < oldestSeq) {
      return { events: [], requiresReset: true };
    }

    return {
      events: this.bufferedEvents.filter(
        (event) => event.seq > normalizedFromSeq,
      ),
      requiresReset: false,
    };
  }

  public subscribe(listener: TerminalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getWriteOwnerId(): string | null {
    return this.writeOwnerId;
  }

  public claimWrite(clientId: string): void {
    this.writeOwnerId = clientId;
    this.publish({
      terminalId: this.terminalId,
      type: "ownership",
      writeOwnerId: this.writeOwnerId,
    });
  }

  public releaseWrite(clientId: string): void {
    if (this.writeOwnerId === clientId) {
      this.writeOwnerId = null;
      this.publish({
        terminalId: this.terminalId,
        type: "ownership",
        writeOwnerId: null,
      });
    }
  }

  public isWriteOwner(clientId: string): boolean {
    return this.writeOwnerId === clientId;
  }

  public async dispose(): Promise<void> {
    this.removed = true;
    this.listeners.clear();
    this.writeOwnerId = null;
    if (!this.terminalProcess) {
      this.running = false;
      return;
    }

    const processHandle = this.terminalProcess;
    this.terminalProcess = null;
    this.running = false;
    try {
      processHandle.kill();
    } catch {
      // Ignore terminal kill failures during shutdown.
    }
  }

  private start(): void {
    const created = createTerminalProcess(this.cwd, this.env);
    this.shell = created.shell;
    this.terminalProcess = created.process;
    this.running = true;
    const processHandle = created.process;

    processHandle.onData((chunk) => {
      this.pushOutput(chunk);
    });

    processHandle.onExit(() => {
      if (this.terminalProcess !== processHandle || this.removed) {
        return;
      }
      this.terminalProcess = null;
      this.running = false;
      this.publish({
        terminalId: this.terminalId,
        type: "state",
        running: false,
      });
      this.onStateChange();
      this.onExitCleanup(this.terminalId);
    });

    this.publish({
      terminalId: this.terminalId,
      type: "state",
      running: true,
    });

    if (created.startupNotice) {
      this.pushOutput(`${created.startupNotice}\r\n`);
    }
  }

  private pushOutput(chunk: string): void {
    if (!chunk) {
      return;
    }
    this.output += chunk;
    if (this.output.length > MAX_OUTPUT_CHARS) {
      this.output = this.output.slice(this.output.length - MAX_OUTPUT_CHARS);
    }
    this.publish({
      terminalId: this.terminalId,
      type: "output",
      chunk,
    });
  }

  private publish(event: TerminalEventWithoutSeq): void {
    const next: TerminalStreamEvent = {
      ...event,
      seq: this.seq + 1,
    };
    this.seq = next.seq;

    this.bufferedEvents.push(next);
    if (this.bufferedEvents.length > MAX_BUFFERED_EVENTS) {
      this.bufferedEvents.splice(
        0,
        this.bufferedEvents.length - MAX_BUFFERED_EVENTS,
      );
    }

    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // Listener errors should not break terminal fan-out.
      }
    }
    this.onStateChange();
  }

  private captureFirstCommand(input: string): void {
    if (this.firstCommand) {
      return;
    }

    for (const char of input) {
      if (char === "\r" || char === "\n") {
        const candidate = this.pendingFirstCommandInput.trim();
        this.pendingFirstCommandInput = "";
        if (candidate) {
          this.firstCommand = candidate;
          this.onStateChange();
          return;
        }
        continue;
      }

      if (char === "\b" || char === "\u007f") {
        this.pendingFirstCommandInput = this.pendingFirstCommandInput.slice(
          0,
          -1,
        );
        continue;
      }

      if (char === "\t") {
        this.pendingFirstCommandInput += " ";
        continue;
      }

      if (char >= " ") {
        this.pendingFirstCommandInput += char;
      }
    }
  }
}

class NodePtyLocalTerminalManager implements LocalTerminalManager {
  private readonly terminals = new Map<string, TerminalInstance>();
  private readonly summaryListeners = new Set<TerminalSummaryListener>();

  public listTerminals(): TerminalSummary[] {
    return [...this.terminals.values()]
      .map((terminal) => terminal.getSummary())
      .sort((left, right) => right.timestamp - left.timestamp);
  }

  public createTerminal(cwd?: string): TerminalSnapshotResponse {
    const normalizedCwd = resolve((cwd?.trim() || process.cwd()).trim());
    const terminalId = createTerminalId();
    const terminal = new TerminalInstance(
      terminalId,
      normalizedCwd,
      Date.now(),
      () => this.notifySummaries(),
      (id) => {
        void this.removeTerminal(id);
      },
    );
    this.terminals.set(terminalId, terminal);
    this.notifySummaries();
    return terminal.getSnapshot();
  }

  public async closeTerminal(terminalId: string): Promise<boolean> {
    if (!this.terminals.has(terminalId)) {
      return false;
    }
    await this.removeTerminal(terminalId);
    return true;
  }

  public getSnapshot(terminalId: string): TerminalSnapshotResponse | null {
    return this.terminals.get(terminalId)?.getSnapshot() ?? null;
  }

  public restart(terminalId: string): TerminalSnapshotResponse | null {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return null;
    }
    return terminal.restart();
  }

  public writeInput(terminalId: string, input: string): void {
    this.terminals.get(terminalId)?.writeInput(input);
  }

  public resize(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.resize(cols, rows);
  }

  public interrupt(terminalId: string): void {
    this.terminals.get(terminalId)?.interrupt();
  }

  public getEventsSince(
    terminalId: string,
    fromSeq: number,
  ): LocalTerminalEventBatch | null {
    return this.terminals.get(terminalId)?.getEventsSince(fromSeq) ?? null;
  }

  public subscribeTerminal(
    terminalId: string,
    listener: TerminalListener,
  ): () => void {
    return (
      this.terminals.get(terminalId)?.subscribe(listener) ?? (() => undefined)
    );
  }

  public subscribeTerminals(listener: TerminalSummaryListener): () => void {
    this.summaryListeners.add(listener);
    return () => {
      this.summaryListeners.delete(listener);
    };
  }

  public getWriteOwnerId(terminalId: string): string | null {
    return this.terminals.get(terminalId)?.getWriteOwnerId() ?? null;
  }

  public claimWrite(terminalId: string, clientId: string): void {
    this.terminals.get(terminalId)?.claimWrite(clientId);
  }

  public releaseWrite(terminalId: string, clientId: string): void {
    this.terminals.get(terminalId)?.releaseWrite(clientId);
  }

  public isWriteOwner(terminalId: string, clientId: string): boolean {
    return this.terminals.get(terminalId)?.isWriteOwner(clientId) ?? false;
  }

  public async dispose(): Promise<void> {
    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    this.summaryListeners.clear();
    await Promise.all(terminals.map((terminal) => terminal.dispose()));
  }

  private notifySummaries(): void {
    const summaries = this.listTerminals();
    for (const listener of this.summaryListeners) {
      try {
        listener(summaries);
      } catch {
        // Ignore list listener errors.
      }
    }
  }

  private async removeTerminal(terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      return;
    }
    this.terminals.delete(terminalId);
    await terminal.dispose();
    this.notifySummaries();
  }
}

function createTerminalId(): string {
  return `terminal-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function resolveShell(): string {
  return (
    resolveShellCandidates()[0] ??
    (process.platform === "win32" ? "cmd.exe" : "sh")
  );
}

function resolveShellCandidates(): string[] {
  const candidates: string[] = [];
  const pushCandidate = (value: string | undefined | null) => {
    const normalized = value?.trim();
    if (!normalized) {
      return;
    }
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  const shellEnv = process.env["SHELL"]?.trim() ?? "";
  if (shellEnv) {
    pushCandidate(shellEnv);
    const firstToken = shellEnv.split(/\s+/)[0];
    if (firstToken) {
      pushCandidate(firstToken);
    }
  }

  if (process.platform === "win32") {
    pushCandidate(process.env["ComSpec"]);
    pushCandidate("powershell.exe");
    pushCandidate("cmd.exe");
    return candidates;
  }

  pushCandidate("/bin/zsh");
  pushCandidate("zsh");
  pushCandidate("/bin/bash");
  pushCandidate("bash");
  pushCandidate("/bin/sh");
  pushCandidate("sh");
  return candidates;
}

function normalizeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

type PtyExitEvent = { exitCode: number; signal?: number };

interface PtyProcess {
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (event: PtyExitEvent) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
}

type PtySpawn = (
  file: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PtyProcess;

let cachedPtySpawn: PtySpawn | null = null;
let ptyUnavailableReason: string | null = null;

function summarizePtyUnavailableReason(reason: string | null): string {
  const normalized = reason?.trim();
  if (!normalized) {
    return "unknown error";
  }

  return (
    normalized
      .split(/\r?\n\s*Require stack:/, 1)[0]
      ?.replace(/\s+/g, " ")
      .trim() ?? "unknown error"
  );
}

function resolveSpawnHelperPath(): string | null {
  try {
    const req = createRequire(import.meta.url);
    return join(
      dirname(req.resolve("node-pty/package.json")),
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
  } catch {
    return null;
  }
}

function ensureSpawnHelperExecutable(): void {
  if (process.platform === "win32") {
    return;
  }
  const helperPath = resolveSpawnHelperPath();
  if (!helperPath) {
    return;
  }
  try {
    const st = statSync(helperPath);
    if (!(st.mode & 0o111)) {
      chmodSync(helperPath, st.mode | 0o111);
    }
  } catch {
    // Best-effort only.
  }
}

function getNodePtySpawn(): PtySpawn | null {
  if (cachedPtySpawn) {
    return cachedPtySpawn;
  }

  try {
    const require = createRequire(import.meta.url);
    const module = require("node-pty") as { spawn?: PtySpawn };
    if (typeof module.spawn !== "function") {
      throw new Error("node-pty spawn export is unavailable");
    }

    ensureSpawnHelperExecutable();

    cachedPtySpawn = module.spawn;
    ptyUnavailableReason = null;
    return cachedPtySpawn;
  } catch (error) {
    ptyUnavailableReason =
      error instanceof Error ? error.message : "Unknown node-pty error";
    return null;
  }
}

function createTerminalProcess(
  cwd: string,
  env: Record<string, string>,
): CreatedTerminalProcess {
  const shellCandidates = resolveShellCandidates();
  const shellForPty = shellCandidates[0] ?? resolveShell();
  const ptySpawn = getNodePtySpawn();
  let ptyFailureMessage: string | null = null;
  if (ptySpawn) {
    for (const shell of shellCandidates) {
      try {
        return {
          process: wrapNodePtyProcess(
            ptySpawn(shell, [], {
              name: "xterm-256color",
              cols: DEFAULT_COLS,
              rows: DEFAULT_ROWS,
              cwd,
              env,
            }),
          ),
          shell,
          startupNotice: null,
        };
      } catch (error) {
        ptyFailureMessage =
          error instanceof Error ? error.message : "Unknown PTY startup error";
      }
    }
  }

  const fallbackNotice =
    ptySpawn && ptyFailureMessage
      ? `[codex-deck] PTY startup failed (${ptyFailureMessage}).` +
        (process.platform !== "win32" &&
        ptyFailureMessage.includes("posix_spawnp")
          ? `\r\n[codex-deck] This is often caused by spawn-helper lacking execute permission.` +
            `\r\n[codex-deck] Try: chmod +x ${resolveSpawnHelperPath() ?? "node_modules/node-pty/prebuilds/*/spawn-helper"}`
          : "") +
        `\r\n[codex-deck] Using fallback non-PTY terminal (limited functionality).`
      : `[codex-deck] node-pty unavailable (${summarizePtyUnavailableReason(ptyUnavailableReason)}).` +
        `\r\n[codex-deck] Full PTY support requires the node-pty native module.` +
        `\r\n[codex-deck] If you're running from this repo, repair it with "pnpm install" or "pnpm rebuild node-pty".` +
        `\r\n[codex-deck] Using fallback non-PTY terminal.`;

  for (const shell of shellCandidates) {
    try {
      return {
        process: createPipeShellProcess(shell, cwd, env),
        shell,
        startupNotice: fallbackNotice,
      };
    } catch {
      // Try next candidate.
    }
  }

  return {
    process: createPipeShellProcess(shellForPty, cwd, env),
    shell: shellForPty,
    startupNotice: fallbackNotice,
  };
}

function wrapNodePtyProcess(processHandle: PtyProcess): TerminalProcessAdapter {
  return {
    onData: (callback) => {
      processHandle.onData(callback);
    },
    onExit: (callback) => {
      processHandle.onExit(() => callback());
    },
    write: (data) => {
      processHandle.write(data);
    },
    resize: (cols, rows) => {
      processHandle.resize(cols, rows);
    },
    interrupt: () => {
      processHandle.write("\u0003");
    },
    kill: () => {
      processHandle.kill();
    },
  };
}

function createPipeShellProcess(
  shell: string,
  cwd: string,
  env: Record<string, string>,
): TerminalProcessAdapter {
  const args = process.platform === "win32" ? [] : ["-i"];
  const child = spawnChild(shell, args, {
    cwd,
    env,
    stdio: "pipe",
  });

  return wrapChildProcess(child);
}

function wrapChildProcess(
  child: ChildProcessWithoutNullStreams,
): TerminalProcessAdapter {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<() => void>();
  let exited = false;

  const emitData = (chunk: Buffer | string) => {
    const text = chunk.toString();
    if (!text) {
      return;
    }
    for (const listener of dataListeners) {
      try {
        listener(text);
      } catch {
        // Ignore listener errors.
      }
    }
  };

  const emitExit = () => {
    if (exited) {
      return;
    }
    exited = true;
    for (const listener of exitListeners) {
      try {
        listener();
      } catch {
        // Ignore listener errors.
      }
    }
  };

  child.stdout.on("data", emitData);
  child.stderr.on("data", emitData);
  child.on("exit", () => emitExit());
  child.on("error", (error) => {
    emitData(`[codex-deck] terminal process error: ${error.message}\n`);
    emitExit();
  });

  return {
    onData: (callback) => {
      dataListeners.add(callback);
    },
    onExit: (callback) => {
      exitListeners.add(callback);
    },
    write: (data) => {
      if (child.stdin.writable) {
        child.stdin.write(data);
      }
    },
    resize: () => {
      // Pipe fallback does not support resize.
    },
    interrupt: () => {
      try {
        if (child.stdin.writable) {
          child.stdin.write("\u0003");
        }
      } catch {
        // Ignore write interruption errors.
      }
      if (process.platform !== "win32") {
        try {
          child.kill("SIGINT");
        } catch {
          // Ignore signal errors.
        }
      }
    },
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore kill errors.
      }
    },
  };
}

let terminalManager: LocalTerminalManager | null = null;
let terminalManagerOverride: LocalTerminalManager | null = null;

export function getLocalTerminalManager(): LocalTerminalManager {
  if (terminalManagerOverride) {
    return terminalManagerOverride;
  }
  if (!terminalManager) {
    terminalManager = new NodePtyLocalTerminalManager();
  }
  return terminalManager;
}

export function setLocalTerminalManagerForTests(
  override: LocalTerminalManager | null,
): void {
  terminalManagerOverride = override;
}

export async function closeLocalTerminalManager(): Promise<void> {
  if (!terminalManager) {
    return;
  }
  const current = terminalManager;
  terminalManager = null;
  await current.dispose();
}
