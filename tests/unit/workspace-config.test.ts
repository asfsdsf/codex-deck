import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("workspace allows node-pty native builds", async () => {
  const workspaceConfig = await readFile(
    new URL("../../pnpm-workspace.yaml", import.meta.url),
    "utf-8",
  );

  assert.match(
    workspaceConfig,
    /onlyBuiltDependencies:\s*(?:\r?\n\s*-\s*"node-pty")/,
  );
});
