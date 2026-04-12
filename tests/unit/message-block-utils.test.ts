import assert from "node:assert/strict";
import test from "node:test";
import {
  getSearchableToolUseText,
  shouldDefaultExpandToolUse,
} from "../../web/message-block-utils";

test("shouldDefaultExpandToolUse expands the intended tool inputs", () => {
  assert.equal(shouldDefaultExpandToolUse("exec_command"), true);
  assert.equal(shouldDefaultExpandToolUse("request_user_input"), true);
  assert.equal(shouldDefaultExpandToolUse("update_plan"), true);
  assert.equal(shouldDefaultExpandToolUse("UPDATE_PLAN"), true);

  assert.equal(shouldDefaultExpandToolUse("read"), false);
  assert.equal(shouldDefaultExpandToolUse(""), false);
  assert.equal(shouldDefaultExpandToolUse(undefined), false);
});

test("getSearchableToolUseText mirrors summarized generic tool input values", () => {
  const text = getSearchableToolUseText({
    type: "tool_use",
    id: "call_test",
    name: "custom_tool",
    input: {
      short: "visible value",
      hiddenLong: "a".repeat(160) + " needle-at-the-end",
      nested: {
        needle: "not directly rendered",
      },
    },
  });

  assert.match(text, /custom_tool/);
  assert.match(text, /short visible value/);
  assert.match(text, /hiddenLong a{140}\.\.\./);
  assert.doesNotMatch(text, /needle-at-the-end/);
  assert.match(text, /nested 1 field\(s\)/);
  assert.doesNotMatch(text, /not directly rendered/);
});
