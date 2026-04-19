import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationMessage } from "@codex-deck/api";
import MessageBlock from "../../web/components/message-block";

(globalThis as { React?: typeof React }).React = React;

function renderMessageBlock(
  message: ConversationMessage,
  options: {
    isAgentsBootstrap?: boolean;
    searchForcePrimaryExpanded?: boolean;
    aiTerminalContext?: React.ComponentProps<
      typeof MessageBlock
    >["aiTerminalContext"];
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(MessageBlock, {
      message,
      isAgentsBootstrap: options.isAgentsBootstrap,
      searchForcePrimaryExpanded: options.searchForcePrimaryExpanded,
      aiTerminalContext: options.aiTerminalContext,
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
  assert.doesNotMatch(html, /&lt;ai-terminal-plan&gt;/);
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
      onApproveStep: () => undefined,
      onRejectStep: () => undefined,
    },
  });

  assert.match(html, /Approve and run/);
  assert.match(html, /Reject/);
  assert.match(html, /Tell the bound session why this step should change/);
  assert.match(html, /aria-label="Reject reason"/);
  assert.match(html, /Pending/);
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
      onApproveStep: () => undefined,
      onRejectStep: () => undefined,
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
