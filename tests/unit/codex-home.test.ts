import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveDefaultCodexHome } from "../../api/codex-home";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

test("resolveDefaultCodexHome uses CODEX_HOME when specified", () => {
  assert.equal(
    resolveDefaultCodexHome("/tmp/custom-codex-home", "/home/example"),
    "/tmp/custom-codex-home",
  );
});

test("resolveDefaultCodexHome trims CODEX_HOME", () => {
  assert.equal(
    resolveDefaultCodexHome("  /tmp/custom-codex-home  ", "/home/example"),
    "/tmp/custom-codex-home",
  );
});

test("resolveDefaultCodexHome falls back to the standard directory", () => {
  assert.equal(
    resolveDefaultCodexHome("  ", "/home/example"),
    join("/home/example", ".codex"),
  );
});

test("codex-deck CLI uses CODEX_HOME when --dir is omitted", () => {
  const codexHome = "/tmp/codex-deck-custom-home";
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "api/index.ts", "--help"],
    {
      cwd: projectRoot,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`Codex directory path \\(default: "${codexHome}"\\)`),
  );
});
