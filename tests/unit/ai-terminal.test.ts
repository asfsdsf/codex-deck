import assert from "node:assert/strict";
import test from "node:test";
import type { SystemContextResponse } from "@codex-deck/api";
import {
  AI_TERMINAL_DEVELOPER_INSTRUCTIONS,
  buildApprovedAiTerminalInput,
  buildAiTerminalEnvironment,
  buildAiTerminalExecutionFeedback,
  buildAiTerminalExecutionWrapper,
  buildAiTerminalRejectionFeedback,
  buildAiTerminalTurnPrompt,
  deriveAiTerminalStepStatesByMessageKey,
  parseAiTerminalBootstrapMessage,
  parseAiTerminalExecutionResult,
  parseAiTerminalMessage,
  parseAiTerminalPersistedStepState,
  parseAiTerminalUserFeedback,
  shouldAttachAiTerminalOutputReference,
  summarizeAiTerminalOutput,
} from "../../web/ai-terminal";

test("parseAiTerminalMessage accepts markdown plus a multi-step plan block", () => {
  const parsed = parseAiTerminalMessage(`
We should inspect memory next.

<ai-terminal-plan>
  <context_note>Run these steps in order.</context_note>
  <ai-terminal-step>
    <step_id>check-load</step_id>
    <step_goal>Check system load</step_goal>
    <command><![CDATA[uptime]]></command>
    <cwd>/repo</cwd>
    <shell>zsh</shell>
    <risk>low</risk>
    <next_action>approve</next_action>
    <explanation>Shows current load average.</explanation>
  </ai-terminal-step>
  <ai-terminal-step>
    <step_id>check-mem</step_id>
    <step_goal>Check memory</step_goal>
    <command><![CDATA[free -m]]></command>
    <cwd>/repo</cwd>
    <shell>zsh</shell>
    <risk>low</risk>
    <next_action>approve</next_action>
    <explanation>Summarizes memory usage in MiB.</explanation>
  </ai-terminal-step>
</ai-terminal-plan>

Then we can continue.
  `);

  assert.ok(parsed);
  assert.equal(parsed?.leadingMarkdown, "We should inspect memory next.");
  assert.equal(parsed?.directive.kind, "plan");
  if (!parsed || parsed.directive.kind !== "plan") {
    assert.fail("expected ai terminal plan");
  }
  assert.equal(parsed.directive.steps.length, 2);
  assert.equal(parsed.directive.steps[0]?.command, "uptime");
  assert.equal(parsed.directive.steps[1]?.stepId, "check-mem");
  assert.equal(parsed.trailingMarkdown, "Then we can continue.");
});

test("parseAiTerminalMessage accepts requirement_finished blocks", () => {
  const parsed = parseAiTerminalMessage(`
Task complete.

<requirement_finished>Review the output before continuing.</requirement_finished>
  `);

  assert.ok(parsed);
  assert.equal(parsed?.directive.kind, "finished");
  if (!parsed || parsed.directive.kind !== "finished") {
    assert.fail("expected finished directive");
  }
  assert.equal(
    parsed.directive.message,
    "Review the output before continuing.",
  );
});

test("parseAiTerminalMessage rejects multiple actionable blocks", () => {
  const parsed = parseAiTerminalMessage(`
<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>one</step_id>
    <command><![CDATA[pwd]]></command>
    <risk>low</risk>
    <next_action>approve</next_action>
  </ai-terminal-step>
</ai-terminal-plan>

<requirement_finished>Done.</requirement_finished>
  `);

  assert.equal(parsed, null);
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
    currentStep: {
      stepId: "step-1",
      stepGoal: "Inspect files",
      command: "find . -type f | head",
      explanation: null,
      cwd: "/repo",
      shell: "zsh",
      risk: "low",
      nextAction: "approve",
      contextNote: null,
    },
  });

  assert.match(prompt, /<os_release>macOS 15\.4\.1<\/os_release>/);
  assert.match(prompt, /<shell>zsh<\/shell>/);
  assert.match(prompt, /<cwd>\/repo<\/cwd>/);
  assert.match(prompt, /<ai-terminal-context>|<ai_terminal_context>/);
});

test("buildAiTerminalExecutionWrapper appends controller marker and optional cwd change", () => {
  const wrapped = buildAiTerminalExecutionWrapper({
    command: "pwd",
    stepId: "step-7",
    cwd: "/repo",
  });

  assert.match(wrapped, /cd '\/repo'/);
  assert.match(wrapped, /pwd/);
  assert.match(wrapped, /__CODEX_DECK_AI_RESULT__/);
  assert.match(wrapped, /step-7/);
});

test("buildApprovedAiTerminalInput sends only the approved command", () => {
  const input = buildApprovedAiTerminalInput({
    command: "git status",
  });

  assert.equal(input, "git status\n");
  assert.doesNotMatch(input, /^cd\s+/m);
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

test("parseAiTerminalExecutionResult strips terminal prompt noise around wrapped output", () => {
  const result = parseAiTerminalExecutionResult({
    stepId: "largest-files",
    rawOutput: [
      "\u001b[1m\u001b[7m%\u001b[27m\u001b[1m\u001b[0m",
      'g\bgit ls-files -z | xargs -0 stat -f "%z %N" | sort -nr | head -n 5',
      "3164935 docs/img/blocks/stacked/all-stacked-vertical.png",
      "\r(base) Project/codex-deck » ",
      "__CODEX_DECK_AI_RESULT__ step=largest-files exit=0 cwd=/repo",
    ].join("\n"),
    timedOut: false,
    fallbackCwd: "/fallback",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.cwdAfter, "/repo");
  assert.equal(result.markerFound, true);
  assert.equal(result.rawOutput.includes("\n%\n"), false);
  assert.equal(result.rawOutput.includes("Project/codex-deck »"), false);
  assert.match(result.outputSummary, /git ls-files -z/);
  assert.match(
    result.outputSummary,
    /docs\/img\/blocks\/stacked\/all-stacked-vertical\.png/,
  );
});

test("buildAiTerminalExecutionFeedback and rejection feedback stay machine-readable", () => {
  const feedback = buildAiTerminalExecutionFeedback({
    result: {
      stepId: "check-mem",
      exitCode: 0,
      timedOut: false,
      cwdAfter: "/repo",
      outputSummary: "Mem: ok",
      errorSummary: null,
      rawOutput: "Mem: ok",
      markerFound: true,
    },
    outputReference: "terminal:t1:seq:10-20",
  });
  const rejection = buildAiTerminalRejectionFeedback({
    stepId: "check-mem",
    reason: "User chose pnpm <test> & avoid ]]> markers.",
  });

  assert.match(feedback, /<ai-terminal-execution>/);
  assert.match(
    feedback,
    /<output_reference>terminal:t1:seq:10-20<\/output_reference>/,
  );
  assert.match(rejection, /<decision>rejected<\/decision>/);
  assert.match(
    rejection,
    /<reason><!\[CDATA\[User chose pnpm <test> & avoid \]\]\]\]><!\[CDATA\[> markers\.\]\]><\/reason>/,
  );
});

test("parseAiTerminalPersistedStepState normalizes execution and rejection feedback", () => {
  const completed = parseAiTerminalPersistedStepState(`
<ai-terminal-execution>
  <step_id>check-mem</step_id>
  <status>success</status>
</ai-terminal-execution>
  `);
  const rejected = parseAiTerminalPersistedStepState(`
<ai-terminal-feedback>
  <step_id>check-mem</step_id>
  <decision>rejected</decision>
</ai-terminal-feedback>
  `);
  const failed = parseAiTerminalPersistedStepState(`
<ai-terminal-execution>
  <step_id>check-mem</step_id>
  <status>timed_out</status>
</ai-terminal-execution>
  `);

  assert.deepEqual(completed, {
    stepId: "check-mem",
    state: "completed",
  });
  assert.deepEqual(rejected, {
    stepId: "check-mem",
    state: "rejected",
  });
  assert.deepEqual(failed, {
    stepId: "check-mem",
    state: "failed",
  });
});

test("parseAiTerminalUserFeedback parses execution summaries with cdata", () => {
  const parsed = parseAiTerminalUserFeedback(`
<ai-terminal-execution>
  <step_id>check-mem</step_id>
  <status>failed</status>
  <exit_code>2</exit_code>
  <cwd_after>/repo</cwd_after>
  <output_summary><![CDATA[stdout <ok> & done]]></output_summary>
  <error_summary><![CDATA[permission denied]]></error_summary>
  <output_reference>terminal:t1:seq:10-20</output_reference>
</ai-terminal-execution>
  `);

  assert.deepEqual(parsed, {
    kind: "execution",
    stepId: "check-mem",
    status: "failed",
    exitCode: 2,
    cwdAfter: "/repo",
    outputSummary: "stdout <ok> & done",
    errorSummary: "permission denied",
    outputReference: "terminal:t1:seq:10-20",
  });
});

test("parseAiTerminalUserFeedback parses rejection reasons and rejects incomplete blocks", () => {
  assert.deepEqual(
    parseAiTerminalUserFeedback(`
<ai-terminal-feedback>
  <step_id>check-mem</step_id>
  <decision>rejected</decision>
  <reason><![CDATA[Use pnpm test instead.]]></reason>
</ai-terminal-feedback>
    `),
    {
      kind: "rejection",
      stepId: "check-mem",
      decision: "rejected",
      reason: "Use pnpm test instead.",
    },
  );

  assert.equal(
    parseAiTerminalUserFeedback(`
<ai-terminal-execution>
  <status>success</status>
</ai-terminal-execution>
    `),
    null,
  );
  assert.equal(parseAiTerminalUserFeedback("plain message"), null);
});

test("parseAiTerminalBootstrapMessage parses controller context and first request", () => {
  const parsed = parseAiTerminalBootstrapMessage(`
(Use skill codex-deck-terminal) This chat is bound to terminal terminal-1. The controller will parse markdown replies.

<ai-terminal-controller-context>
<terminal_id>terminal-1</terminal_id>
<cwd>/repo</cwd>
<shell>/bin/zsh</shell>
<os_name>macOS</os_name>
<os_release>macOS 26.4.1</os_release>
<architecture>arm64</architecture>
<platform>darwin</platform>
</ai-terminal-controller-context>

Treat the next section as the user's first request for this terminal chat session.

User first request:
<user-request>
Show largest 10 files
</user-request>
  `);

  assert.deepEqual(parsed, {
    kind: "bootstrap",
    terminalId: "terminal-1",
    cwd: "/repo",
    shell: "/bin/zsh",
    osName: "macOS",
    osRelease: "macOS 26.4.1",
    architecture: "arm64",
    platform: "darwin",
    userRequest: "Show largest 10 files",
  });
});

test("parseAiTerminalBootstrapMessage rejects unrelated or incomplete messages", () => {
  assert.equal(parseAiTerminalBootstrapMessage("plain message"), null);
  assert.equal(
    parseAiTerminalBootstrapMessage(`
<ai-terminal-controller-context>
<cwd>/repo</cwd>
</ai-terminal-controller-context>
    `),
    null,
  );
});

test("buildAiTerminalExecutionFeedback marks unknown exit code as completed_unknown", () => {
  const feedback = buildAiTerminalExecutionFeedback({
    result: {
      stepId: "check-files",
      exitCode: null,
      timedOut: false,
      cwdAfter: "/repo",
      outputSummary: "Output captured without explicit shell exit code.",
      errorSummary: null,
      rawOutput: "Output captured without explicit shell exit code.",
      markerFound: false,
    },
  });

  assert.match(feedback, /<status>completed_unknown<\/status>/);
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
  assert.equal(shouldAttachAiTerminalOutputReference(output), true);
});

test("deriveAiTerminalStepStatesByMessageKey reconstructs terminal card state from conversation history", () => {
  const messages = [
    {
      type: "assistant",
      uuid: "plan-1",
      message: {
        role: "assistant",
        content: `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>check-mem</step_id>
    <command><![CDATA[free -m]]></command>
    <risk>low</risk>
    <next_action>approve</next_action>
  </ai-terminal-step>
</ai-terminal-plan>`,
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: `<ai-terminal-feedback>
  <step_id>check-mem</step_id>
  <decision>rejected</decision>
</ai-terminal-feedback>`,
      },
    },
    {
      type: "assistant",
      uuid: "plan-2",
      message: {
        role: "assistant",
        content: `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>check-mem</step_id>
    <command><![CDATA[free -m]]></command>
    <risk>low</risk>
    <next_action>approve</next_action>
  </ai-terminal-step>
</ai-terminal-plan>`,
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: `<ai-terminal-execution>
  <step_id>check-mem</step_id>
  <status>success</status>
</ai-terminal-execution>`,
      },
    },
  ] as const;

  const statesByMessageKey = deriveAiTerminalStepStatesByMessageKey(messages, {
    getMessage: (message) => message,
    getMessageKey: (message) => message.uuid,
  });

  assert.deepEqual(statesByMessageKey, {
    "plan-1": {
      "check-mem": "rejected",
    },
    "plan-2": {
      "check-mem": "completed",
    },
  });
});

test("ai terminal developer instructions enforce tagged plan contract", () => {
  assert.match(AI_TERMINAL_DEVELOPER_INSTRUCTIONS, /<ai-terminal-plan>/);
  assert.match(
    AI_TERMINAL_DEVELOPER_INSTRUCTIONS,
    /markdown plus exactly one machine-readable action block/i,
  );
});
