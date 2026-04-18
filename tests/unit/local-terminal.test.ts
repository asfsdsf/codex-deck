import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearTerminalBinding,
  setTerminalBinding,
} from "../../api/terminal-bindings";
import {
  closeLocalTerminalManager,
  getLocalTerminalManager,
  setLocalTerminalManagerForTests,
  setTerminalProcessFactoryForTests,
} from "../../api/local-terminal";
import { initStorage } from "../../api/storage";
import { createTempCodexDir, waitFor } from "./test-utils";

interface FakeProcessHandle {
  cwd: string;
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
    factory: (cwd: string) => {
      const dataListeners = new Set<(data: string) => void>();
      const exitListeners = new Set<() => void>();
      let exited = false;

      const handle: FakeProcessHandle = {
        cwd,
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

test("consumeFrozenBlockSnapshot returns only the current captured block and keeps resize dimensions", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "local-terminal-snapshot-capture",
  );
  const processFactory = createFakeTerminalProcessFactory();

  initStorage(rootDir);
  await closeLocalTerminalManager();
  setLocalTerminalManagerForTests(null);
  setTerminalProcessFactoryForTests(processFactory.factory);

  try {
    const manager = getLocalTerminalManager();
    const created = manager.createTerminal("/repo/app");

    processFactory.handles[0]?.emitData("first block\r\n");
    const firstSnapshot = await manager.consumeFrozenBlockSnapshot(
      created.terminalId,
    );
    assert.ok(firstSnapshot);
    assert.equal(firstSnapshot.cols, 80);
    assert.equal(firstSnapshot.rows, 24);
    assert.match(firstSnapshot.data, /first block/);
    assert.equal(firstSnapshot.data.includes("second block"), false);

    manager.resize(created.terminalId, 120, 40);
    processFactory.handles[0]?.emitData("second block\r\n");
    const secondSnapshot = await manager.consumeFrozenBlockSnapshot(
      created.terminalId,
    );
    assert.ok(secondSnapshot);
    assert.equal(secondSnapshot.cols, 120);
    assert.equal(secondSnapshot.rows, 40);
    assert.match(secondSnapshot.data, /second block/);
    assert.equal(secondSnapshot.data.includes("first block"), false);
  } finally {
    await closeLocalTerminalManager();
    setTerminalProcessFactoryForTests(null);
    await cleanup();
  }
});
