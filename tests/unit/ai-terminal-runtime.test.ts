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
      "(base) codex-deck » {",
      "(base) codex-deck » cd '/repo' || exit 1",
      "(base) codex-deck » pwd",
      "(base) codex-deck » __CODEX_DECK_AI_STEP_ID=step-1",
      "/repo",
      "(base) codex-deck » __CODEX_DECK_AI_RESULT__ step=step-1 exit=0 cwd=/repo",
    ].join("\n"),
  );

  assert.equal(cleaned, "/repo");
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
