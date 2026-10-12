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

test("getSearchableToolUseText indexes commands wrapped by exec", () => {
  const text = getSearchableToolUseText({
    type: "tool_use",
    id: "call_exec",
    name: "exec",
    input: {
      raw: 'const r = await tools.exec_command({cmd:"cat /repo/README.md",workdir:"/repo"});text(r.output)',
    },
  });

  assert.equal(text, "exec_command\ncat /repo/README.md");
});

test("getSearchableToolUseText indexes JSON-wrapped exec commands", () => {
  const text = getSearchableToolUseText({
    type: "tool_use",
    id: "call_json_exec",
    name: "exec",
    input: {
      raw: 'const r = await tools.exec_command({"cmd":"pwd && ls","workdir":"/repo"});text(r.output)',
    },
  });

  assert.equal(text, "exec_command\npwd && ls");
});

test("exec batches expand by default and index all commands", () => {
  const input = {
    raw: `await Promise.allSettled([
  tools.exec_command({cmd:"sed -n '1,238p' NvChad/find_actions.lua"}),
  tools.exec_command({cmd:"cat tests/find_actions.lua; sed -n '50,95p' NvChad/README.md"})
]);`,
  };
  assert.equal(shouldDefaultExpandToolUse("exec", input), true);
  assert.equal(
    getSearchableToolUseText({ type: "tool_use", name: "exec", input }),
    "exec_command\nsed -n '1,238p' NvChad/find_actions.lua\nexec_command\ncat tests/find_actions.lua; sed -n '50,95p' NvChad/README.md",
  );
});

test("getSearchableToolUseText indexes the full script of an unparsed exec batch", () => {
  const raw = `await tools.exec_command({cmd:"${"echo first; ".repeat(20)}"});
await tools.exec_command(optionsForSecondCommand);`;
  const text = getSearchableToolUseText({
    type: "tool_use",
    name: "exec",
    input: { raw },
  });
  assert.match(text, /optionsForSecondCommand/);
});

test("getSearchableToolUseText indexes wrapped write_stdin sessions", () => {
  const text = getSearchableToolUseText({
    type: "tool_use",
    id: "call_write_stdin",
    name: "exec",
    input: {
      raw: 'const r = await tools.write_stdin({session_id:17188, chars:"", yield_time_ms:30000, max_output_tokens:5000}); text(r)',
    },
  });

  assert.equal(text, "write_stdin\nsession 17188");
});
