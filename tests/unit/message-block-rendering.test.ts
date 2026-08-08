import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationMessage } from "@codex-deck/api";
import MessageBlock, {
  shouldClearAiTerminalPendingAction,
  shouldRenderAiTerminalStepActions,
} from "../../web/components/message-block";

(globalThis as { React?: typeof React }).React = React;

function renderMessageBlock(
  message: ConversationMessage,
  options: {
    isAgentsBootstrap?: boolean;
    searchForcePrimaryExpanded?: boolean;
    searchForceBlockIndex?: number | null;
    aiTerminalContext?: React.ComponentProps<
      typeof MessageBlock
    >["aiTerminalContext"];
    onEditMessage?: React.ComponentProps<typeof MessageBlock>["onEditMessage"];
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(MessageBlock, {
      message,
      isAgentsBootstrap: options.isAgentsBootstrap,
      searchForcePrimaryExpanded: options.searchForcePrimaryExpanded,
      searchForceBlockIndex: options.searchForceBlockIndex,
      aiTerminalContext: options.aiTerminalContext,
      onEditMessage: options.onEditMessage,
    }),
  );
}

test("MessageBlock renders <skill> payloads with skill card header and preview", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `<skill>
<name>skill-installer</name>
<path>/Users/example/.codex/skills/.system/skill-installer/SKILL.md</path>
---
name: skill-installer
description: Install skills.
---

# Skill Installer

Installs curated skills.
</skill>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Skill/);
  assert.match(html, /\$skill-installer/);
  assert.match(html, /Name: skill-installer/);
  assert.match(
    html,
    /Path: \/Users\/example\/\.codex\/skills\/\.system\/skill-installer\/SKILL\.md/,
  );
});

test("MessageBlock keeps AGENTS bootstrap rendering behavior", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `<INSTRUCTIONS>
# Repository Instructions
Use tests before committing.
</INSTRUCTIONS>`,
    },
  };

  const html = renderMessageBlock(message, { isAgentsBootstrap: true });
  assert.match(html, /AGENTS\.md/);
  assert.match(html, /Session instructions/);
});

test("MessageBlock expands AGENTS bootstrap content for search focus", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `<INSTRUCTIONS>
line 1
line 2
line 3
line 4 use-search-target
</INSTRUCTIONS>`,
        },
      ],
    },
  };

  const collapsedHtml = renderMessageBlock(message, {
    isAgentsBootstrap: true,
  });
  assert.doesNotMatch(collapsedHtml, /line 4 use-search-target/);

  const expandedHtml = renderMessageBlock(message, {
    isAgentsBootstrap: true,
    searchForcePrimaryExpanded: true,
  });
  assert.match(expandedHtml, /line 4 use-search-target/);
});

test("MessageBlock renders wrapped exec commands as command tools", () => {
  const html = renderMessageBlock({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "wrapped-command",
          name: "exec",
          input: {
            raw: 'const r = await tools.exec_command({cmd:"cat /repo/README.md",workdir:"/repo"});text(r.output)',
          },
        },
      ],
    },
  });

  assert.match(html, /exec_command/);
  assert.match(html, /cat \/repo\/README\.md/);
  assert.doesNotMatch(html, /tools\.exec_command/);
});

test("MessageBlock renders JSON-wrapped exec command options", () => {
  const html = renderMessageBlock({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "json-wrapped-command",
          name: "exec",
          input: {
            raw: 'const r = await tools.exec_command({"cmd":"pwd && ls","workdir":"/repo","yield_time_ms":10000,"max_output_tokens":20000});\ntext(r.output);\n',
          },
        },
      ],
    },
  });

  assert.match(html, /exec_command/);
  assert.match(html, /pwd &amp;&amp; ls/);
  assert.match(html, /workdir/);
  assert.match(html, /\/repo/);
  assert.match(html, /yield_time_ms/);
  assert.match(html, /max_output_tokens/);
  assert.doesNotMatch(html, /tools\.exec_command/);
});

test("MessageBlock renders wrapped write_stdin polling details", () => {
  const html = renderMessageBlock({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "wrapped-write-stdin",
          name: "exec",
          input: {
            raw: 'const r = await tools.write_stdin({session_id:17188, chars:"", yield_time_ms:30000, max_output_tokens:5000}); text(r)\n',
          },
        },
      ],
    },
  });

  assert.match(html, /write_stdin/);
  assert.match(html, /Process input/);
  assert.match(html, /Session/);
  assert.match(html, /17188/);
  assert.match(html, /\(empty\)/);
  assert.match(html, /Wait up to/);
  assert.match(html, /30s/);
  assert.match(html, /Output limit/);
  assert.match(html, /5,000 tokens/);
  assert.doesNotMatch(html, /tools\.write_stdin/);
});

test("MessageBlock renders wrapped apply_patch calls as patch tools", () => {
  const rawPatch = [
    "*** Begin Patch",
    "*** Update File: /repo/src/example.ts",
    "@@ -1 +1 @@",
    "-export const value = 0;",
    "+export const value = 1;",
    "*** End Patch",
  ].join("\\n");
  const html = renderMessageBlock(
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "wrapped-patch",
            name: "exec",
            input: {
              raw: `const patch = "${rawPatch}";\nconst result = await tools.apply_patch(patch);\ntext(result);`,
            },
          },
        ],
      },
    },
    { searchForcePrimaryExpanded: true, searchForceBlockIndex: 0 },
  );

  assert.match(html, /apply_patch/);
  assert.match(html, /src\/example\.ts/);
  assert.doesNotMatch(html, /tools\.apply_patch/);
});

test("MessageBlock shows patch line counts in the folded preview", () => {
  const html = renderMessageBlock({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "folded-patch",
          name: "apply_patch",
          input: {
            raw: [
              "*** Begin Patch",
              "*** Update File: /repo/src/example.ts",
              "@@ -1,2 +1,3 @@",
              " const a = 1;",
              "-const b = 2;",
              "+const b = 3;",
              "+const c = 4;",
              "*** End Patch",
            ].join("\n"),
          },
        },
      ],
    },
  });

  assert.match(html, /apply_patch/);
  assert.match(html, /example\.ts \(\+2 -1\)/);
  assert.doesNotMatch(html, /const b = 2/);
});

test("MessageBlock renders yielded process waits with a concise preview", () => {
  const html = renderMessageBlock({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "wait-cell-16",
          name: "wait",
          input: {
            cell_id: "16",
            yield_time_ms: 30_000,
            max_tokens: 25_000,
          },
        },
      ],
    },
  });

  assert.match(html, /lucide-clock-3/);
  assert.match(html, />wait</);
  assert.match(html, /process 16 · up to 30s/);
  assert.doesNotMatch(html, /cell_id/);
  assert.doesNotMatch(html, /yield_time_ms/);
});

test("MessageBlock renders token limit notices with repeat counter in header", () => {
  const message: ConversationMessage = {
    type: "token_limit_notice",
    repeatCount: 3,
    repeatCountMax: 6,
    summary: "Rate Limit Reached",
    message: {
      role: "assistant",
      content:
        "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.",
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Rate Limit Reached 3\/6/);
  assert.match(html, /Token count updates hit the Codex rate limit/);
});

test("MessageBlock renders reasoning token usage from last token usage", () => {
  const message: ConversationMessage = {
    type: "reasoning",
    message: {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Plan steps",
          token_usage: {
            input_tokens: 1200,
            output_tokens: 345,
            total_tokens: 1545,
            reasoning_output_tokens: 123,
          },
        },
      ],
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /reasoning/);
  assert.match(html, /123 reasoning tokens/);
});

test("MessageBlock hides a single token limit notice", () => {
  const message: ConversationMessage = {
    type: "token_limit_notice",
    repeatCount: 1,
    repeatCountMax: 6,
    summary: "Rate Limit Reached",
    message: {
      role: "assistant",
      content:
        "Token count updates hit the Codex rate limit. Codex is waiting and retrying automatically.",
    },
  };

  const html = renderMessageBlock(message);
  assert.equal(html, "");
});

test("MessageBlock renders thread goal messages as an expanded goal callout", () => {
  const message: ConversationMessage = {
    type: "thread_goal",
    summary: "Active",
    threadGoal: {
      threadId: "thread-1",
      objective: "Improve benchmark coverage",
      status: "active",
      tokenBudget: 10000,
      tokensUsed: 1250,
      timeUsedSeconds: 90,
      createdAt: 100,
      updatedAt: 120,
    },
    message: {
      role: "assistant",
      content: "Improve benchmark coverage",
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Goal Active/);
  assert.match(html, /Improve benchmark coverage/);
  assert.match(html, /1m/);
  assert.match(html, /1,250 \/ 10K tokens/);
  assert.match(html, /<p class="[^"]*">Improve benchmark coverage<\/p>/);
  assert.doesNotMatch(html, /▶|▼/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /threadId/);
});

test("MessageBlock renders goal internal context without raw XML tags", () => {
  const message: ConversationMessage = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<codex_internal_context source="Goal">
Continue working toward the active thread goal.

<goal>
Improve benchmark coverage
</goal>
</codex_internal_context>`,
        },
      ],
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Goal Context/);
  assert.match(html, /Continue working toward the active thread goal/);
  assert.match(html, /Improve benchmark coverage/);
  assert.match(html, /▶/);
  assert.doesNotMatch(html, /codex_internal_context/);
  assert.doesNotMatch(html, /&lt;goal&gt;/);

  const expandedHtml = renderMessageBlock(message, {
    searchForceBlockIndex: 0,
  });
  assert.match(expandedHtml, /▼/);
  assert.match(
    expandedHtml,
    /<p class="[^"]*">Continue working toward the active thread goal\.<\/p>/,
  );
});

test("MessageBlock renders ai terminal plan cards and hides raw tags", () => {
  const message: ConversationMessage = {
    type: "assistant",
    message: {
      role: "assistant",
      content: `We should inspect memory next.

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
</ai-terminal-plan>

Then continue.`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /AI Terminal Plan/);
  assert.match(html, /Check system load/);
  assert.match(html, /uptime/);
  assert.match(html, /We should inspect memory next\./);
  assert.match(html, /Then continue\./);
  assert.match(html, /title="Show raw text"/);
  assert.match(html, /&lt;\/&gt;/);
  assert.doesNotMatch(html, /&lt;ai-terminal-plan&gt;/);
});

test("MessageBlock renders ai terminal risk styling for medium and high risk steps", () => {
  const message: ConversationMessage = {
    type: "assistant",
    message: {
      role: "assistant",
      content: `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>dangerous-preview</step_id>
    <step_goal>Preview dangerous operation</step_goal>
    <command><![CDATA[rm -rf ./cache]]></command>
    <cwd>/repo</cwd>
    <shell>zsh</shell>
    <risk>medium</risk>
    <next_action>approve</next_action>
    <explanation>This needs confirmation.</explanation>
  </ai-terminal-step>
  <ai-terminal-step>
    <step_id>dangerous-run</step_id>
    <step_goal>Run dangerous operation</step_goal>
    <command><![CDATA[rm -rf /important]]></command>
    <cwd>/repo</cwd>
    <shell>zsh</shell>
    <risk>high</risk>
    <next_action>approve</next_action>
    <explanation>This is destructive.</explanation>
  </ai-terminal-step>
</ai-terminal-plan>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Risk medium/);
  assert.match(html, /Risk high/);
  assert.match(
    html,
    /border-orange-500\/35 bg-orange-500\/10 shadow-\[0_0_0_1px_rgba\(249,115,22,0\.08\)\]/,
  );
  assert.match(html, /border-orange-400\/40 bg-orange-500\/12 text-orange-100/);
  assert.match(
    html,
    /border-red-500\/35 bg-red-500\/10 shadow-\[0_0_0_1px_rgba\(239,68,68,0\.08\)\]/,
  );
  assert.match(html, /border-red-400\/40 bg-red-500\/12 text-red-100/);
});

test("MessageBlock renders ai terminal action buttons when the plan is actionable", () => {
  const message: ConversationMessage = {
    type: "assistant",
    message: {
      role: "assistant",
      content: `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>check-mem</step_id>
    <step_goal>Check memory</step_goal>
    <command><![CDATA[free -m]]></command>
    <cwd>/repo</cwd>
    <shell>zsh</shell>
    <risk>low</risk>
    <next_action>approve</next_action>
    <explanation>Summarize memory usage.</explanation>
  </ai-terminal-step>
</ai-terminal-plan>`,
    },
  };

  const html = renderMessageBlock(message, {
    aiTerminalContext: {
      sessionId: "session-1",
      terminalId: "terminal-1",
      messageKey: "msg-1",
      isActionable: true,
      stepStates: {
        "check-mem": "pending",
      },
      onApproveStep: async () => true,
      onRejectStep: async () => true,
    },
  });

  assert.match(html, /Approve and run/);
  assert.match(html, /Reject/);
  assert.match(html, /Tell the bound session why this step should change/);
  assert.match(html, /aria-label="Reject reason"/);
  assert.match(html, /Pending/);
});

test("MessageBlock hides ai terminal action buttons when step actions are visually disabled", () => {
  const message: ConversationMessage = {
    type: "assistant",
    message: {
      role: "assistant",
      content: `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>check-mem</step_id>
    <step_goal>Check memory</step_goal>
    <command><![CDATA[free -m]]></command>
    <cwd>/repo</cwd>
    <shell>zsh</shell>
    <risk>low</risk>
    <next_action>approve</next_action>
    <explanation>Summarize memory usage.</explanation>
  </ai-terminal-step>
</ai-terminal-plan>`,
    },
  };

  const html = renderMessageBlock(message, {
    aiTerminalContext: {
      sessionId: "session-1",
      terminalId: "terminal-1",
      messageKey: "msg-1",
      isActionable: true,
      showStepActions: false,
      stepStates: {
        "check-mem": "pending",
      },
      onApproveStep: async () => true,
      onRejectStep: async () => true,
    },
  });

  assert.doesNotMatch(html, /Approve and run/);
  assert.doesNotMatch(html, /Reject/);
  assert.doesNotMatch(html, /aria-label="Reject reason"/);
  assert.match(html, /Pending/);
});

test("MessageBlock keeps terminal step actions mounted while approval is pending", () => {
  assert.equal(
    shouldRenderAiTerminalStepActions({
      canApprove: false,
      canReject: false,
      pendingAction: "approving",
    }),
    true,
  );
  assert.equal(
    shouldRenderAiTerminalStepActions({
      canApprove: false,
      canReject: false,
    }),
    false,
  );
});

test("MessageBlock clears local pending action once CLI-backed step state advances", () => {
  assert.equal(
    shouldClearAiTerminalPendingAction({
      isActionable: true,
      persistedState: "running",
    }),
    true,
  );
  assert.equal(
    shouldClearAiTerminalPendingAction({
      isActionable: true,
      persistedState: undefined,
    }),
    false,
  );
});

test("MessageBlock hides ai terminal action buttons after a terminal step is decided", () => {
  const message: ConversationMessage = {
    type: "assistant",
    message: {
      role: "assistant",
      content: `<ai-terminal-plan>
  <ai-terminal-step>
    <step_id>check-mem</step_id>
    <step_goal>Check memory</step_goal>
    <command><![CDATA[free -m]]></command>
    <cwd>/repo</cwd>
    <shell>zsh</shell>
    <risk>low</risk>
    <next_action>approve</next_action>
    <explanation>Summarize memory usage.</explanation>
  </ai-terminal-step>
</ai-terminal-plan>`,
    },
  };

  const html = renderMessageBlock(message, {
    aiTerminalContext: {
      sessionId: "session-1",
      terminalId: "terminal-1",
      messageKey: "msg-1",
      isActionable: true,
      stepStates: {
        "check-mem": "failed",
      },
      onApproveStep: async () => true,
      onRejectStep: async () => true,
    },
  });

  assert.doesNotMatch(html, /Approve and run/);
  assert.doesNotMatch(html, /Reject/);
  assert.match(html, /Failed/);
});

test("MessageBlock renders terminal execution user feedback and hides raw tags", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `<ai-terminal-execution>
  <step_id>check-mem</step_id>
  <status>success</status>
  <exit_code>0</exit_code>
  <cwd_after>/repo</cwd_after>
  <output_summary><![CDATA[Mem: ok]]></output_summary>
  <output_reference>terminal:t1:seq:10-20</output_reference>
</ai-terminal-execution>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Terminal Step/);
  assert.match(html, /Success/);
  assert.match(html, /check-mem/);
  assert.match(html, /Exit 0/);
  assert.match(html, /\/repo/);
  assert.match(html, /Mem: ok/);
  assert.match(html, /terminal:t1:seq:10-20/);
  assert.match(html, /title="Show raw text"/);
  assert.match(html, /&lt;\/&gt;/);
  assert.doesNotMatch(html, /&lt;ai-terminal-execution&gt;/);
});

test("MessageBlock renders terminal failed execution error summary", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `<ai-terminal-execution>
  <step_id>run-tests</step_id>
  <status>timed_out</status>
  <exit_code></exit_code>
  <cwd_after>/repo</cwd_after>
  <output_summary><![CDATA[Tests started.]]></output_summary>
  <error_summary><![CDATA[Command timed out.]]></error_summary>
</ai-terminal-execution>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Timed out/);
  assert.match(html, /Tests started\./);
  assert.match(html, /Command timed out\./);
  assert.doesNotMatch(html, /&lt;error_summary&gt;/);
});

test("MessageBlock renders terminal rejection user feedback and hides raw tags", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `<ai-terminal-feedback>
  <step_id>check-mem</step_id>
  <decision>rejected</decision>
  <reason><![CDATA[Use pnpm test instead.]]></reason>
</ai-terminal-feedback>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Terminal Step/);
  assert.match(html, /Rejected/);
  assert.match(html, /check-mem/);
  assert.match(html, /Use pnpm test instead\./);
  assert.match(html, /title="Show raw text"/);
  assert.doesNotMatch(html, /&lt;ai-terminal-feedback&gt;/);
});

test("MessageBlock renders terminal bootstrap user messages and hides raw tags", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `(Use skill codex-deck-terminal) This chat is bound to terminal terminal-ufyscs8a5kdz. The controller will parse markdown replies that contain one terminal tag block such as <ai-terminal-plan>, <ai-terminal-need-input>, or <requirement_finished>.

<ai-terminal-controller-context>
<terminal_id>terminal-ufyscs8a5kdz</terminal_id>
<cwd>/Users/zky/Programming/Web/Project/codex-deck</cwd>
<shell>/bin/zsh</shell>
<os_name>macOS</os_name>
<os_release>macOS 26.4.1</os_release>
<architecture>arm64</architecture>
<platform>darwin</platform>
</ai-terminal-controller-context>

<terminal-command-output>
<terminal_id>terminal-ufyscs8a5kdz</terminal_id>
<content><![CDATA[$ ls
package.json]]></content>
</terminal-command-output>

Treat the next section as the user's first request for this terminal chat session.

User first request:
<user-request>
Show larget 10 fiels
</user-request>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Terminal Chat/);
  assert.match(html, /terminal-ufyscs8a5kdz/);
  assert.match(html, /\/Users\/zky\/Programming\/Web\/Project\/codex-deck/);
  assert.match(html, /\/bin\/zsh/);
  assert.match(html, /macOS 26\.4\.1/);
  assert.match(html, /arm64/);
  assert.match(html, /darwin/);
  assert.match(html, /Show larget 10 fiels/);
  assert.match(html, /package\.json/);
  assert.match(html, /title="Show raw text"/);
  assert.doesNotMatch(html, /&lt;ai-terminal-controller-context&gt;/);
  assert.doesNotMatch(html, /&lt;user-request&gt;/);
});

test("MessageBlock renders terminal command output user messages and hides raw tags", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `Please explain the failure.

<terminal-command-output>
<terminal_id>terminal-ufyscs8a5kdz</terminal_id>
<content><![CDATA[$ pnpm test
FAIL src/example.test.ts]]></content>
</terminal-command-output>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Terminal Context/);
  assert.match(html, /Please explain the failure\./);
  assert.match(html, /\$ pnpm test/);
  assert.match(html, /FAIL src\/example\.test\.ts/);
  assert.doesNotMatch(html, /&lt;terminal-command-output&gt;/);
});

test("MessageBlock renders tagged terminal restart notices with a styled callout and hides raw tags", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `<terminal-restart-message>Terminal context notice: The terminal session was restarted. Shell state such as environment variables, aliases, and running processes may have been lost. Do not respond to or act on this notice.</terminal-restart-message>

Please continue from the previous output.

<terminal-command-output>
<terminal_id>terminal-ufyscs8a5kdz</terminal_id>
<content><![CDATA[$ pnpm test
FAIL src/example.test.ts]]></content>
</terminal-command-output>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Terminal restarted/i);
  assert.match(html, /Please continue from the previous output\./);
  assert.match(html, /\$ pnpm test/);
  assert.doesNotMatch(html, /&lt;terminal-restart-message&gt;/);
});

test("MessageBlock renders frozen output as scrollable plain text with styled omission notices", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: `Please inspect the captured output.

<terminal-command-output>
<terminal_id>terminal-ufyscs8a5kdz</terminal_id>
<content><![CDATA[line 1
**literal markdown**
<codex-deck-frozen-terminal-omitted-lines-notice omitted-lines="15">15 lines omitted from frozen terminal output.</codex-deck-frozen-terminal-omitted-lines-notice>
line 40
<codex-deck-frozen-terminal-omitted-characters-notice omitted-characters="120">120 characters omitted from frozen terminal output.</codex-deck-frozen-terminal-omitted-characters-notice>
line 80]]></content>
</terminal-command-output>`,
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Terminal Context/);
  assert.match(html, /Please inspect the captured output\./);
  assert.match(
    html,
    /max-h-72 overflow-auto rounded-lg border border-zinc-800\/80 bg-zinc-950\/80/,
  );
  assert.match(html, /15 lines omitted from frozen terminal output\./);
  assert.match(html, /120 characters omitted from frozen terminal output\./);
  assert.match(html, /line 1/);
  assert.match(html, /line 40/);
  assert.match(html, /line 80/);
  assert.match(html, /\*\*literal markdown\*\*/);
  assert.doesNotMatch(html, /<strong[^>]*>literal markdown<\/strong>/);
  assert.doesNotMatch(html, /codex-deck-frozen-terminal-omitted-lines-notice/);
  assert.doesNotMatch(
    html,
    /codex-deck-frozen-terminal-omitted-characters-notice/,
  );
});

test("MessageBlock keeps normal user markdown rendering for unrelated messages", () => {
  const message: ConversationMessage = {
    type: "user",
    message: {
      role: "user",
      content: "Please run **tests** next.",
    },
  };

  const html = renderMessageBlock(message);
  assert.match(html, /Please run/);
  assert.match(
    html,
    /<strong class="font-semibold text-zinc-50">tests<\/strong>/,
  );
  assert.doesNotMatch(html, /Terminal Step/);
});

test("MessageBlock translates user messages to the reader language", () => {
  const html = renderMessageBlock({
    type: "user",
    message: {
      role: "user",
      content: "Please run the tests.",
    },
  });

  assert.match(html, /title="Translate message to Chinese"/);
  assert.doesNotMatch(html, /Translate message to English/);
});

test("MessageBlock offers editing only for messages marked editable", () => {
  const editableMessage: ConversationMessage = {
    type: "assistant",
    editable: true,
    editId: "item:message-1",
    editText: "Editable reply",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Editable reply" }],
    },
  };
  const editableHtml = renderMessageBlock(editableMessage, {
    onEditMessage: async () => undefined,
  });
  assert.match(editableHtml, /aria-label="Edit history message"/);

  const toolMessage: ConversationMessage = {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "command output",
        },
      ],
    },
  };
  const toolHtml = renderMessageBlock(toolMessage, {
    onEditMessage: async () => undefined,
  });
  assert.doesNotMatch(toolHtml, /aria-label="Edit history message"/);
});
