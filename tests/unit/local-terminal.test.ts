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
  setCommandExecutionProcessFactoryForTests,
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

function createFakeCommandExecutionProcessFactory() {
  const handles: Array<{
    shell: string;
    cwd: string;
    command: string;
    kills: number;
    emitData: (chunk: string) => void;
    emitExit: (exitCode: number | null) => void;
  }> = [];

  return {
    handles,
    factory: (input: {
      shell: string;
      cwd: string;
      env: Record<string, string>;
      command: string;
    }) => {
      const dataListeners = new Set<(chunk: string) => void>();
      const exitListeners = new Set<
        (event: { exitCode: number | null }) => void
      >();
      let exited = false;
      const handle = {
        shell: input.shell,
        cwd: input.cwd,
        command: input.command,
        kills: 0,
        emitData: (chunk: string) => {
          for (const listener of dataListeners) {
            listener(chunk);
          }
        },
        emitExit: (exitCode: number | null) => {
          if (exited) {
            return;
          }
          exited = true;
          for (const listener of exitListeners) {
            listener({ exitCode });
          }
        },
      };
      handles.push(handle);
      return {
        onData: (callback: (chunk: string) => void) => {
          dataListeners.add(callback);
        },
        onExit: (callback: (event: { exitCode: number | null }) => void) => {
          exitListeners.add(callback);
        },
        kill: () => {
          handle.kills += 1;
          handle.emitExit(null);
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

test("executeCommand streams visible output without leaking controller marker", async () => {
  const { rootDir, cleanup } = await createTempCodexDir(
    "local-terminal-execute",
  );
  const processFactory = createFakeTerminalProcessFactory();
  const commandFactory = createFakeCommandExecutionProcessFactory();

  initStorage(rootDir);
  await closeLocalTerminalManager();
  setLocalTerminalManagerForTests(null);
  setTerminalProcessFactoryForTests(processFactory.factory);
  setCommandExecutionProcessFactoryForTests(commandFactory.factory);

  try {
    const manager = getLocalTerminalManager();
    const created = manager.createTerminal("/repo/app");
    const statePath = join(
      rootDir,
      "codex-deck",
      "terminal",
      "state",
      `${created.terminalId}.json`,
    );
    processFactory.handles[0]?.emitData("(base) Project/codex-deck » ");

    const executionPromise = manager.executeCommand(created.terminalId, {
      command:
        "find . -type f -print0 | xargs -0 stat -f '%z %N' | sort -n | head -n 4",
      cwd: "/repo/app",
      displayCommand:
        "find . -type f -print0 | xargs -0 stat -f '%z %N' | sort -n | head -n 4",
    });

    const executionHandle = commandFactory.handles[0];
    assert.ok(executionHandle);
    executionHandle.emitData(
      "0 ./node_modules/.pnpm/example-a\n0 ./node_modules/.pnpm/example-b\n",
    );
    executionHandle.emitData(
      "\n__CODEX_DECK_TERMINAL_EXEC_RESULT__ exit=0 cwd=/repo/app\n",
    );
    executionHandle.emitExit(0);

    const result = await executionPromise;
    assert.ok(result);
    assert.equal(result.exitCode, 0);
    assert.equal(result.cwdAfter, "/repo/app");
    assert.equal(result.timedOut, false);
    assert.equal(result.startOffset, "(base) Project/codex-deck » ".length);
    assert.equal(
      result.rawOutput,
      "0 ./node_modules/.pnpm/example-a\n0 ./node_modules/.pnpm/example-b",
    );

    const snapshot = manager.getSnapshot(created.terminalId);
    assert.ok(snapshot);
    assert.match(
      snapshot.output,
      /Project\/codex-deck » find \. -type f -print0 \| xargs -0 stat -f '%z %N' \| sort -n \| head -n 4\r?\n0 \.\/node_modules\/\.pnpm\/example-a/,
    );
    assert.equal(
      snapshot.output.includes("__CODEX_DECK_TERMINAL_EXEC_RESULT__"),
      false,
    );
    assert.equal(snapshot.output.includes("__CODEX_DECK_AI_RESULT__"), false);
    await waitFor(() => existsSync(statePath));
  } finally {
    await closeLocalTerminalManager();
    setCommandExecutionProcessFactoryForTests(null);
    setTerminalProcessFactoryForTests(null);
    await cleanup();
  }
});
