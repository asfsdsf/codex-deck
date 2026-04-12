import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function collectTestFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

const testsDirectory = resolve("tests/unit");
const testFiles = collectTestFiles(testsDirectory).sort();

if (testFiles.length === 0) {
  console.error(`No unit test files found under ${testsDirectory}`);
  process.exit(1);
}

const runnerCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  runnerCommand,
  ["exec", "tsx", "--tsconfig", "tsconfig.test.json", "--test", ...testFiles],
  {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
