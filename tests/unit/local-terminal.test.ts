import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  clearTerminalBinding,
  setTerminalBinding,
} from "../../api/terminal-bindings";
import {
  closeLocalTerminalManager,
  getLocalTerminalManager,
  resolveTerminalCwd,
  setLocalTerminalManagerForTests,
  setTerminalProcessFactoryForTests,
  TerminalWorkingDirectoryError,
} from "../../api/local-terminal";
import type { TerminalStreamEvent } from "../../api/storage";
import { initStorage } from "../../api/storage";
import { createTempCodexDir, waitFor } from "./test-utils";

interface FakeProcessHandle {
  cwd: string;
  size: { cols: number; rows: number } | null;
  writes: string[];
  resizeCalls: Array<{ cols: number; rows: number }>;
  interruptCalls: number;
  killCalls: number;
  emitData: (chunk: string) => void;
  emitExit: () => void;
}

function createFakeTerminalProcessFactory() {
  const handles: FakeProcessHandle[] = [];

  return {
    handles,
    factory: (
      cwd: string,
      _env?: Record<string, string>,
      size?: { cols: number; rows: number },
    ) => {
      const dataListeners = new Set<(data: string) => void>();
      const exitListeners = new Set<() => void>();
      let exited = false;

      const handle: FakeProcessHandle = {
        cwd,
        size: size ?? null,
        writes: [],
        resizeCalls: [],
        interruptCalls: 0,
        killCalls: 0,
        emitData: (chunk: string) => {
          for (const listener of dataListeners) {
            listener(chunk);
          }
        },
        emitExit: () => {
          if (exited) {
            return;
          }
          exited = true;
          for (const listener of exitListeners) {
            listener();
          }
        },
      };

      handles.push(handle);

      return {
        shell: "fake-zsh",
        startupNotice: null,
        process: {
          onData: (callback: (data: string) => void) => {
            dataListeners.add(callback);
          },
          onExit: (callback: () => void) => {
            exitListeners.add(callback);
          },
          write: (data: string) => {
            handle.writes.push(data);
          },
          resize: (cols: number, rows: number) => {
            handle.resizeCalls.push({ cols, rows });
          },
          interrupt: () => {
            handle.interruptCalls += 1;
          },
          kill: () => {
            handle.killCalls += 1;
            handle.emitExit();
          },
        },
      };
    },
  };
}

test("bound terminals remain after exit while unbound terminals are removed", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("local-terminal-bound");
  const processFactory = createFakeTerminalProcessFactory();
  let boundTerminalId: string | null = null;

  initStorage(rootDir);
  await closeLocalTerminalManager();
  setLocalTerminalManagerForTests(null);
  setTerminalProcessFactoryForTests(processFactory.factory);

  try {
    const manager = getLocalTerminalManager();
    const boundTerminal = manager.createTerminal("/repo/bound");
    const unboundTerminal = manager.createTerminal("/repo/unbound");
    boundTerminalId = boundTerminal.terminalId;

    manager.writeInput(boundTerminal.terminalId, "pnpm test\n");
    await setTerminalBinding(boundTerminal.terminalId, "session-bound");

    processFactory.handles[0]?.emitExit();
    processFactory.handles[1]?.emitExit();

    await waitFor(() => manager.listTerminals().length === 1);

    const remaining = manager.listTerminals()[0];
    assert.ok(remaining);
    assert.equal(remaining.terminalId, boundTerminal.terminalId);
    assert.equal(remaining.running, false);
    assert.equal(remaining.firstCommand, "pnpm test");
    assert.equal(manager.getSnapshot(boundTerminal.terminalId)?.running, false);
    assert.equal(
      manager.getSnapshot(boundTerminal.terminalId)?.writeOwnerId,
      null,
    );
    assert.equal(manager.getSnapshot(unboundTerminal.terminalId), null);
  } finally {
    if (boundTerminalId) {
      await clearTerminalBinding(boundTerminalId);
    }
    await closeLocalTerminalManager();
    setTerminalProcessFactoryForTests(null);
    await cleanup();
  }
});

test("bound terminals rehydrate after manager restart as stopped rows", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "local-terminal-rehydrate",
  );
  const processFactory = createFakeTerminalProcessFactory();
  let terminalId: string | null = null;

  initStorage(rootDir);
  await closeLocalTerminalManager();
  setLocalTerminalManagerForTests(null);
  setTerminalProcessFactoryForTests(processFactory.factory);

  try {
    const manager = getLocalTerminalManager();
    const created = manager.createTerminal("/repo/app");
    terminalId = created.terminalId;
    manager.writeInput(created.terminalId, "npm run dev\n");
    await setTerminalBinding(created.terminalId, "session-rehydrate");

    const statePath = join(
      rootDir,
      "codex-deck",
      "terminal",
      "state",
      `${created.terminalId}.json`,
    );
    await waitFor(() => {
      if (!existsSync(statePath)) {
        return false;
      }
      const text = readFileSync(statePath, "utf-8");
      return text.includes('"firstCommand": "npm run dev"');
    });

    assert.equal(processFactory.handles.length, 1);

    await closeLocalTerminalManager();

    const restoredManager = getLocalTerminalManager();
    const terminals = restoredManager.listTerminals();
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.terminalId, created.terminalId);
    assert.equal(terminals[0]?.running, false);
    assert.equal(terminals[0]?.cwd, "/repo/app");
    assert.equal(terminals[0]?.shell, "fake-zsh");
    assert.equal(terminals[0]?.firstCommand, "npm run dev");
    assert.equal(processFactory.handles.length, 1);

    const restoredSnapshot = restoredManager.getSnapshot(created.terminalId);
    assert.ok(restoredSnapshot);
    assert.equal(restoredSnapshot.running, false);
    assert.equal(restoredSnapshot.output, "");
    assert.equal(restoredSnapshot.shell, "fake-zsh");

    const restarted = restoredManager.restart(created.terminalId);
    assert.ok(restarted);
    assert.equal(restarted.running, true);
    assert.equal(processFactory.handles.length, 2);
  } finally {
    if (terminalId) {
      await clearTerminalBinding(terminalId);
    }
    await closeLocalTerminalManager();
    setTerminalProcessFactoryForTests(null);
    await cleanup();
  }
});

test("getEventsSince only requires a reset when the buffer has a gap", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "local-terminal-events-since",
  );
  const processFactory = createFakeTerminalProcessFactory();

  initStorage(rootDir);
  await closeLocalTerminalManager();
  setLocalTerminalManagerForTests(null);
  setTerminalProcessFactoryForTests(processFactory.factory);

  try {
    const manager = getLocalTerminalManager();
    const terminal = manager.createTerminal("/repo/app");

    // seq 1 is the initial "state" event; emit enough output to trim the
    // 2000-event buffer so the oldest buffered seq is 102.
    for (let index = 0; index < 2100; index += 1) {
      processFactory.handles[0]?.emitData(`chunk-${index}\n`);
    }

    const covered = manager.getEventsSince(terminal.terminalId, 101);
    assert.ok(covered);
    assert.equal(covered.requiresReset, false);
    assert.equal(covered.events.length, 2000);
    assert.equal(covered.events[0]?.seq, 102);

    const gap = manager.getEventsSince(terminal.terminalId, 100);
    assert.ok(gap);
    assert.equal(gap.requiresReset, true);
    assert.equal(gap.events.length, 0);

    await manager.closeTerminal(terminal.terminalId);
  } finally {
    await closeLocalTerminalManager();
    setTerminalProcessFactoryForTests(null);
    await cleanup();
  }
});

test("resolveTerminalCwd expands ~ and resolves relative paths", () => {
  assert.equal(resolveTerminalCwd("~"), homedir());
  assert.equal(
    resolveTerminalCwd("~/projects/app"),
    join(homedir(), "projects/app"),
  );
  assert.equal(resolveTerminalCwd("  /repo/app  "), "/repo/app");
  assert.equal(resolveTerminalCwd("relative/dir"), resolve("relative/dir"));
  assert.equal(resolveTerminalCwd(""), resolve(process.cwd()));
  assert.equal(resolveTerminalCwd(undefined), resolve(process.cwd()));
});

test("creating a terminal in a missing directory fails with a clear error", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "local-terminal-missing-cwd",
  );

  initStorage(rootDir);
  await closeLocalTerminalManager();
  setLocalTerminalManagerForTests(null);
  // The real process factory validates the directory before spawning.
  setTerminalProcessFactoryForTests(null);

  try {
    const manager = getLocalTerminalManager();
    const missing = join(rootDir, "does-not-exist");
    assert.throws(
      () => manager.createTerminal(missing),
      (error: unknown) =>
        error instanceof TerminalWorkingDirectoryError &&
        error.message === `Directory does not exist: ${missing}`,
    );
    assert.deepEqual(manager.listTerminals(), []);
  } finally {
    await closeLocalTerminalManager();
    await cleanup();
  }
});

test("snapshots report the PTY size and restarts keep it", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "local-terminal-pty-size",
  );
  const processFactory = createFakeTerminalProcessFactory();

  initStorage(rootDir);
  await closeLocalTerminalManager();
  setLocalTerminalManagerForTests(null);
  setTerminalProcessFactoryForTests(processFactory.factory);

  try {
    const manager = getLocalTerminalManager();
    const created = manager.createTerminal("/repo/app");
    assert.equal(created.cols, 80);
    assert.equal(created.rows, 24);
    assert.deepEqual(processFactory.handles[0]?.size, { cols: 80, rows: 24 });

    manager.resize(created.terminalId, 120, 40);
    assert.deepEqual(processFactory.handles[0]?.resizeCalls, [
      { cols: 120, rows: 40 },
    ]);
    const resized = manager.getSnapshot(created.terminalId);
    assert.equal(resized?.cols, 120);
    assert.equal(resized?.rows, 40);

    const events: TerminalStreamEvent[] = [];
    const unsubscribe = manager.subscribeTerminal(
      created.terminalId,
      (event) => {
        events.push(event);
      },
    );
    processFactory.handles[0]?.emitData("old output\r\n");
    const restarted = manager.restart(created.terminalId);
    unsubscribe();

    // The new shell starts at the size the client last asked for.
    assert.deepEqual(processFactory.handles[1]?.size, { cols: 120, rows: 40 });
    assert.equal(restarted?.cols, 120);
    assert.equal(restarted?.output, "");
    const reset = events.find((event) => event.type === "reset");
    assert.deepEqual(reset && { ...reset, seq: 0 }, {
      terminalId: created.terminalId,
      type: "reset",
      output: "",
      running: false,
      cols: 120,
      rows: 40,
      seq: 0,
    });

    await manager.closeTerminal(created.terminalId);
  } finally {
    await closeLocalTerminalManager();
    setTerminalProcessFactoryForTests(null);
    await cleanup();
  }
});

test("retained output is trimmed at a line boundary", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("local-terminal-trim");
  const processFactory = createFakeTerminalProcessFactory();

  initStorage(rootDir);
  await closeLocalTerminalManager();
  setLocalTerminalManagerForTests(null);
  setTerminalProcessFactoryForTests(processFactory.factory);

  try {
    const manager = getLocalTerminalManager();
    const terminal = manager.createTerminal("/repo/app");
    const line = `\u001b[32m${"x".repeat(90)}\u001b[0m\r\n`;
    for (let index = 0; index < 12_000; index += 1) {
      processFactory.handles[0]?.emitData(line);
    }

    const output = manager.getSnapshot(terminal.terminalId)?.output ?? "";
    assert.ok(output.length <= 1_000_000 + 128_000);
    assert.ok(output.length > 900_000);
    assert.ok(output.startsWith("\u001b[32m"));
    assert.ok(output.endsWith(line));

    await manager.closeTerminal(terminal.terminalId);
  } finally {
    await closeLocalTerminalManager();
    setTerminalProcessFactoryForTests(null);
    await cleanup();
  }
});
