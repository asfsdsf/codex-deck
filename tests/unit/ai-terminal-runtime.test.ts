import assert from "node:assert/strict";
import test from "node:test";
import { cleanLiveAiTerminalExecutionOutput } from "../../web/ai-terminal-runtime";

test("cleanLiveAiTerminalExecutionOutput drops wrapper echo noise before visible output", () => {
  const cleaned = cleanLiveAiTerminalExecutionOutput(
    {
      stepId: "step-1",
      command: "pwd",
      cwd: "/repo",
    },
    [
      "(base) codex-deck » pwd",
      "/repo",
      "(base) codex-deck »",
    ].join("\n"),
  );

  assert.equal(cleaned, "/repo");
});

test("cleanLiveAiTerminalExecutionOutput preserves literal marker-like output", () => {
  const cleaned = cleanLiveAiTerminalExecutionOutput(
    {
      stepId: "step-3",
      command: "cat build.log",
      cwd: "/repo",
    },
    [
      "(base) codex-deck » cat build.log",
      "__CODEX_DECK_AI_RESULT__ should stay visible now",
      "(base) codex-deck »",
    ].join("\n"),
  );

  assert.equal(cleaned, "__CODEX_DECK_AI_RESULT__ should stay visible now");
});

test("cleanLiveAiTerminalExecutionOutput keeps meaningful output after prompt fragments", () => {
  const cleaned = cleanLiveAiTerminalExecutionOutput(
    {
      stepId: "step-2",
      command: "find . -maxdepth 1 -type f",
      cwd: "/repo",
    },
    [
      "(base) codex-deck » find . -maxdepth 1 -type f",
      "README.md",
      "package.json",
      "(base) codex-deck »",
    ].join("\n"),
  );

  assert.equal(cleaned, "README.md\npackage.json");
});
