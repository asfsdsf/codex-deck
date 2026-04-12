import assert from "node:assert/strict";
import test from "node:test";
import {
  findActiveSkillSelectorToken,
  getSkillSelectorSuggestions,
} from "../../web/skill-selector";

test("findActiveSkillSelectorToken resolves the token under cursor", () => {
  const draft = "Use $openai-docs for this request.";
  const tokenStart = draft.indexOf("$openai-docs");
  const cursor = draft.indexOf("docs");
  const token = findActiveSkillSelectorToken(draft, cursor);

  assert.deepEqual(token, {
    query: "openai-docs",
    start: tokenStart,
    end: tokenStart + "$openai-docs".length,
  });
});

test("findActiveSkillSelectorToken allows an empty query", () => {
  const token = findActiveSkillSelectorToken("Try $", 5);
  assert.deepEqual(token, {
    query: "",
    start: 4,
    end: 5,
  });
});

test("findActiveSkillSelectorToken ignores $ inside a non-whitespace token", () => {
  assert.equal(findActiveSkillSelectorToken("foo$bar", 4), null);

  const spaced = findActiveSkillSelectorToken("foo $bar", 7);
  assert.equal(spaced?.query, "bar");
});

test("getSkillSelectorSuggestions returns ordered matches and honors limit", () => {
  const skills = [
    {
      name: "openai-docs",
      displayName: "OpenAI Docs",
      description: "Official docs helper",
    },
    {
      name: "playwright",
      displayName: "Browser Automation",
      description: "Run Playwright",
    },
    {
      name: "tmux-exec",
      displayName: "Tmux Exec",
      description: "Reliable tmux execution",
    },
  ];

  assert.deepEqual(
    getSkillSelectorSuggestions("", skills, 2).map((skill) => skill.name),
    ["openai-docs", "playwright"],
  );

  assert.deepEqual(
    getSkillSelectorSuggestions("play", skills).map((skill) => skill.name),
    ["playwright"],
  );

  assert.deepEqual(
    getSkillSelectorSuggestions("docs", skills).map((skill) => skill.name),
    ["openai-docs"],
  );
});
