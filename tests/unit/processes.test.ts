import assert from "node:assert/strict";
import test from "node:test";
import type {
  CodexBackgroundTerminal,
  SessionTerminalRunSummary,
} from "../../api/storage";
import { mergeSessionProcesses } from "../../web/processes";
import {
  isProcessRefreshInterval,
  parseProcessRefreshSettings,
} from "../../web/process-refresh-settings";

const run: SessionTerminalRunSummary = {
  processId: "123",
  callId: "call-123",
  command: "pnpm dev",
  isRunning: true,
  startedAt: "2026-11-26T00:00:00Z",
  endedAt: null,
  latestActivityAt: "2026-11-26T00:00:01Z",
};
const terminal: CodexBackgroundTerminal = {
  itemId: "item-123",
  processId: "123",
  command: "pnpm dev",
  cwd: "/workspace",
  osPid: 456,
  cpuPercent: 1.5,
  rssKb: 4096,
};

test("Process refresh defaults are 0.5s locally and 2s remotely", () => {
  assert.deepEqual(parseProcessRefreshSettings(null), {
    local: 500,
    remote: 2000,
  });
  assert.deepEqual(parseProcessRefreshSettings("not json"), {
    local: 500,
    remote: 2000,
  });
  assert.deepEqual(parseProcessRefreshSettings("null"), {
    local: 500,
    remote: 2000,
  });
});

test("Process refresh settings preserve valid modes and reject unsafe intervals", () => {
  assert.deepEqual(
    parseProcessRefreshSettings('{"local":1250,"remote":10000}'),
    { local: 1250, remote: 10000 },
  );
  assert.deepEqual(parseProcessRefreshSettings('{"local":0,"remote":3000}'), {
    local: 500,
    remote: 3000,
  });
  for (const invalid of [-100, 0, 99, 60001, Infinity, NaN, "500", null]) {
    assert.equal(isProcessRefreshInterval(invalid), false);
  }
  assert.equal(isProcessRefreshInterval(100), true);
  assert.equal(isProcessRefreshInterval(60000), true);
});

test("Process entries combine saved output identities with live process metrics", () => {
  const processes = mergeSessionProcesses([run], [terminal]);
  assert.equal(processes.length, 1);
  assert.equal(processes[0]?.callId, "call-123");
  assert.equal(processes[0]?.terminal?.osPid, 456);
  assert.equal(processes[0]?.isRunning, true);
  assert.equal(mergeSessionProcesses([], [terminal])[0]?.command, "pnpm dev");
});

test("Process entries retain completed commands for inspecting final output", () => {
  const previous = mergeSessionProcesses([run], [terminal]);
  const completed = mergeSessionProcesses([], [], previous);
  assert.equal(completed[0]?.processId, "123");
  assert.equal(completed[0]?.isRunning, false);
  assert.equal(completed[0]?.terminal?.cwd, "/workspace");
  assert.equal(mergeSessionProcesses([run], [], previous)[0]?.isRunning, false);
});

test("Process entries fall back to saved status when live process discovery fails", () => {
  assert.equal(mergeSessionProcesses([run], null)[0]?.isRunning, true);
  const previous = mergeSessionProcesses([run], [terminal]);
  const other = { ...terminal, processId: "789", itemId: "item-789" };
  const next = mergeSessionProcesses([], [other], previous);
  assert.equal(next[0]?.processId, "789");
  assert.equal(next[1]?.processId, "123");
  assert.equal(next[1]?.isRunning, false);
});

test("Process history limits never hide active processes", () => {
  const terminals = Array.from({ length: 101 }, (_, index) => ({
    ...terminal,
    processId: String(index),
  }));
  const processes = mergeSessionProcesses([], terminals);
  assert.equal(processes.length, 101);
  assert.equal(
    processes.every((process) => process.isRunning),
    true,
  );
  assert.equal(mergeSessionProcesses([], [], processes).length, 100);
});
