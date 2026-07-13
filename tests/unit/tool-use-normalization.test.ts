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
      input: { cmd: "cat /repo/file with spaces.md" },
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

test("normalizeToolUse preserves unknown exec programs", () => {
  const input = { raw: "const answer = 42; text(answer);" };
  assert.deepEqual(normalizeToolUse("exec", input), { name: "exec", input });
});
