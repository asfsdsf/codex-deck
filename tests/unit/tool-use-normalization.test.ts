import assert from "node:assert/strict";
import test from "node:test";
import { normalizeToolUse } from "../../web/tool-use-normalization";

test("normalizeToolUse unwraps exec_command calls", () => {
  assert.deepEqual(
    normalizeToolUse("exec", {
      raw: 'const r = await tools.exec_command({cmd:"cat /repo/file with spaces.md",workdir:"/repo",yield_time_ms:10000});text(r.output)\n',
    }),
    {
      name: "exec_command",
      input: {
        cmd: "cat /repo/file with spaces.md",
        workdir: "/repo",
        yield_time_ms: 10000,
      },
    },
  );
});

test("normalizeToolUse unwraps JSON exec_command calls and preserves options", () => {
  assert.deepEqual(
    normalizeToolUse("exec", {
      raw: 'const r = await tools.exec_command({"cmd":"pwd && ls","workdir":"/repo","yield_time_ms":10000,"max_output_tokens":20000});\ntext(r.output);\n',
    }),
    {
      name: "exec_command",
      input: {
        cmd: "pwd && ls",
        workdir: "/repo",
        yield_time_ms: 10000,
        max_output_tokens: 20000,
      },
    },
  );
});

test("normalizeToolUse unwraps apply_patch variables", () => {
  const raw =
    'const patch = "*** Begin Patch\\n*** Add File: /repo/new.ts\\n+export const value = \\\"quoted\\\";\\n*** End Patch";\n' +
    "const result = await tools.apply_patch(patch);\ntext(result);";

  assert.deepEqual(normalizeToolUse("exec", { raw }), {
    name: "apply_patch",
    input: {
      raw: [
        "*** Begin Patch",
        "*** Add File: /repo/new.ts",
        '+export const value = "quoted";',
        "*** End Patch",
      ].join("\n"),
    },
  });
});

test("normalizeToolUse unwraps write_stdin calls and preserves options", () => {
  assert.deepEqual(
    normalizeToolUse("exec", {
      raw: 'const r = await tools.write_stdin({session_id:17188, chars:"", yield_time_ms:30000, max_output_tokens:5000}); text(r)\n',
    }),
    {
      name: "write_stdin",
      input: {
        session_id: 17188,
        chars: "",
        yield_time_ms: 30000,
        max_output_tokens: 5000,
      },
    },
  );
});

test("normalizeToolUse preserves unknown exec programs", () => {
  const input = { raw: "const answer = 42; text(answer);" };
  assert.deepEqual(normalizeToolUse("exec", input), { name: "exec", input });
});

test("normalizeToolUse preserves every command in an exec batch", () => {
  const input = {
    raw: `const results = await Promise.allSettled([
  tools.exec_command({cmd:"sed -n '1,238p' NvChad/find_actions.lua", max_output_tokens:7600}),
  tools.exec_command({cmd:"cat tests/find_actions.lua; sed -n '50,95p' NvChad/README.md", max_output_tokens:7000})
]);
for (const result of results) text(result);`,
  };

  assert.deepEqual(normalizeToolUse("exec", input), {
    name: "exec",
    input,
    calls: [
      {
        name: "exec_command",
        input: {
          cmd: "sed -n '1,238p' NvChad/find_actions.lua",
          max_output_tokens: 7600,
        },
      },
      {
        name: "exec_command",
        input: {
          cmd: "cat tests/find_actions.lua; sed -n '50,95p' NvChad/README.md",
          max_output_tokens: 7000,
        },
      },
    ],
  });
});

test("normalizeToolUse keeps mixed exec calls in source order", () => {
  const input = {
    raw: `text(await tools.exec_command({cmd:"git status --short"}));
const patch = "*** Begin Patch\\n*** End Patch";
text(await tools.apply_patch(patch));
text(await tools.write_stdin({session_id:123, chars:"", yield_time_ms:1000}));`,
  };

  assert.deepEqual(normalizeToolUse("exec", input), {
    name: "exec",
    input,
    calls: [
      { name: "exec_command", input: { cmd: "git status --short" } },
      { name: "apply_patch", input: { raw: "*** Begin Patch\n*** End Patch" } },
      {
        name: "write_stdin",
        input: { session_id: 123, chars: "", yield_time_ms: 1000 },
      },
    ],
  });
});

test("normalizeToolUse ignores tool call text in strings and comments", () => {
  assert.deepEqual(
    normalizeToolUse("exec", {
      raw: `// tools.apply_patch("ignored")
/* tools.exec_command({cmd:"ignored"}) */
const example = 'tools.apply_patch("ignored")';
text(await tools.exec_command({cmd:"echo tools.exec_command({})"}));`,
    }),
    { name: "exec_command", input: { cmd: "echo tools.exec_command({})" } },
  );
});

test("normalizeToolUse preserves the script when any batched call cannot be parsed", () => {
  for (const raw of [
    'await tools.exec_command({cmd:"pwd"}); await tools.exec_command(options);',
    'await tools.exec_command({cmd:"pwd"}); await tools.some_other_tool({path:"/repo"});',
  ]) {
    const input = { raw };
    assert.deepEqual(normalizeToolUse("exec", input), { name: "exec", input });
  }
});
