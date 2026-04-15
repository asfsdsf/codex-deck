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
