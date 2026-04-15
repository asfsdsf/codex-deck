import assert from "node:assert/strict";
import test from "node:test";
import type { SystemContextResponse } from "@codex-deck/api";
import {
  AI_TERMINAL_DEVELOPER_INSTRUCTIONS,
  buildAiTerminalEnvironment,
  buildAiTerminalExecutionWrapper,
  buildAiTerminalTurnPrompt,
  parseAiTerminalExecutionResult,
  parseAiTerminalResponse,
  summarizeAiTerminalOutput,
} from "../../web/ai-terminal";

test("parseAiTerminalResponse accepts command proposals", () => {
  const parsed = parseAiTerminalResponse(`
<state>await_approval</state>
<command><![CDATA[pnpm test]]></command>
<explanation>Run the unit test suite.</explanation>
<cwd>/repo</cwd>
<shell>zsh</shell>
<risk>low</risk>
<step_id>step-1</step_id>
<step_goal>Verify current behavior.</step_goal>
<next_action>approve</next_action>
  `);

  assert.ok(parsed);
  assert.equal(parsed?.state, "await_approval");
  assert.equal(parsed?.command, "pnpm test");
  assert.equal(parsed?.stepId, "step-1");
  assert.equal(parsed?.risk, "low");
});

test("parseAiTerminalResponse accepts completion tags without command", () => {
  const parsed = parseAiTerminalResponse(`
<state>finished</state>
<requirement_finished>Review the output before continuing.</requirement_finished>
  `);

  assert.ok(parsed);
  assert.equal(parsed?.state, "finished");
  assert.equal(parsed?.command, null);
  assert.equal(
    parsed?.requirementFinished,
    "Review the output before continuing.",
  );
});

test("buildAiTerminalTurnPrompt includes live environment facts", () => {
  const system: SystemContextResponse = {
    osName: "macOS",
    osRelease: "macOS 15.4.1",
    osVersion: "15.4.1",
    architecture: "arm64",
    platform: "darwin",
    hostname: "host",
    defaultShell: "/bin/zsh",
  };
  const environment = buildAiTerminalEnvironment({
    system,
    cwd: "/repo",
    shell: "zsh",
  });

  const prompt = buildAiTerminalTurnPrompt({
    environment,
    userRequest: "List the largest files here.",
    userFollowup: null,
    latestExecution: null,
    history: [],
    currentStep: null,
  });

  assert.match(prompt, /<os_release>macOS 15\.4\.1<\/os_release>/);
  assert.match(prompt, /<shell>zsh<\/shell>/);
  assert.match(prompt, /<cwd>\/repo<\/cwd>/);
  assert.match(prompt, /List the largest files here\./);
});

test("buildAiTerminalExecutionWrapper appends controller marker", () => {
  const wrapped = buildAiTerminalExecutionWrapper({
    command: "pwd",
    stepId: "step-7",
  });

  assert.match(wrapped, /pwd/);
  assert.match(wrapped, /__CODEX_DECK_AI_RESULT__/);
  assert.match(wrapped, /step-7/);
});

test("parseAiTerminalExecutionResult extracts exit code and cwd", () => {
  const result = parseAiTerminalExecutionResult({
    stepId: "step-2",
    rawOutput:
      "pwd\n/repo\n__CODEX_DECK_AI_RESULT__ step=step-2 exit=0 cwd=/repo\n",
    timedOut: false,
    fallbackCwd: "/fallback",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.cwdAfter, "/repo");
  assert.equal(result.markerFound, true);
  assert.match(result.outputSummary, /pwd/);
});

test("summarizeAiTerminalOutput compacts large output and extracts errors", () => {
  const output = [
    "line 1",
    "line 2",
    "line 3",
    "line 4",
    "line 5",
    "line 6",
    "line 7",
    "line 8",
    "line 9",
    "line 10",
    "ERROR: missing file",
    "line 12",
    "line 13",
    "line 14",
    "line 15",
    "line 16",
    "line 17",
    "line 18",
  ].join("\n");

  const summary = summarizeAiTerminalOutput(output);
  assert.match(summary.outputSummary, /more lines omitted/);
  assert.equal(summary.errorSummary, "ERROR: missing file");
});

test("ai terminal developer instructions enforce XML-only contract", () => {
  assert.match(AI_TERMINAL_DEVELOPER_INSTRUCTIONS, /<requirement_finished>/);
  assert.match(
    AI_TERMINAL_DEVELOPER_INSTRUCTIONS,
    /Output machine-readable XML-like tags only/,
  );
});
