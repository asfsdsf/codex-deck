import assert from "node:assert/strict";
import test from "node:test";
import {
  findActiveFileMentionToken,
  getFileMentionSuggestions,
} from "../../web/file-mentions";

test("findActiveFileMentionToken resolves the token under cursor", () => {
  const draft = "Please inspect @web/app.tsx and report back.";
  const tokenStart = draft.indexOf("@web/app.tsx");
  const cursor = draft.indexOf("app.tsx");
  const token = findActiveFileMentionToken(draft, cursor);

  assert.deepEqual(token, {
    query: "web/app.tsx",
    start: tokenStart,
    end: tokenStart + "@web/app.tsx".length,
  });
});

test("findActiveFileMentionToken keeps the same token for nested @ characters", () => {
  const draft = "npx -y @scope/pkg@latest";
  const cursorOnSecondAt = draft.lastIndexOf("@latest");

  const token = findActiveFileMentionToken(draft, cursorOnSecondAt);
  assert.equal(token?.query, "scope/pkg@latest");
});

test("findActiveFileMentionToken ignores @ inside a non-whitespace token", () => {
  assert.equal(findActiveFileMentionToken("foo@bar", 4), null);

  const spaced = findActiveFileMentionToken("foo @bar", 7);
  assert.equal(spaced?.query, "bar");
});

test("getFileMentionSuggestions returns ordered matches and honors limit", () => {
  const files = [
    "web/app.tsx",
    "web/components/slash-command-palette.tsx",
    "api/server.ts",
    "README.md",
  ];

  assert.deepEqual(getFileMentionSuggestions("", files, 2), [
    "web/app.tsx",
    "web/components/slash-command-palette.tsx",
  ]);

  assert.deepEqual(getFileMentionSuggestions("app", files), ["web/app.tsx"]);
  assert.deepEqual(getFileMentionSuggestions("server", files), [
    "api/server.ts",
  ]);
  assert.deepEqual(getFileMentionSuggestions("read", files), ["README.md"]);
});
