import test from "node:test";
import assert from "node:assert/strict";
import {
  findConversationSearchMatches,
  normalizeConversationSearchQuery,
} from "../../web/conversation-search";

test("normalizeConversationSearchQuery trims and lowercases input", () => {
  assert.equal(normalizeConversationSearchQuery("  HeLLo  "), "hello");
});

test("findConversationSearchMatches finds case-insensitive matches", () => {
  const matches = findConversationSearchMatches(["Alpha beta ALPHA"], "alpha");

  assert.deepEqual(matches, [
    {
      startFragmentIndex: 0,
      startOffset: 0,
      endFragmentIndex: 0,
      endOffset: 5,
    },
    {
      startFragmentIndex: 0,
      startOffset: 11,
      endFragmentIndex: 0,
      endOffset: 16,
    },
  ]);
});

test("findConversationSearchMatches resolves matches across fragment boundaries", () => {
  const matches = findConversationSearchMatches(
    ["Searching ", "across ", "nodes works"],
    "across nodes",
  );

  assert.deepEqual(matches, [
    {
      startFragmentIndex: 1,
      startOffset: 0,
      endFragmentIndex: 2,
      endOffset: 5,
    },
  ]);
});

test("findConversationSearchMatches skips overlapping matches", () => {
  const matches = findConversationSearchMatches(["ababa"], "aba");

  assert.deepEqual(matches, [
    {
      startFragmentIndex: 0,
      startOffset: 0,
      endFragmentIndex: 0,
      endOffset: 3,
    },
  ]);
});
