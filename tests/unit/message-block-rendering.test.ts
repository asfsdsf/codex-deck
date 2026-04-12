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
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(MessageBlock, {
      message,
      isAgentsBootstrap: options.isAgentsBootstrap,
      searchForcePrimaryExpanded: options.searchForcePrimaryExpanded,
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
