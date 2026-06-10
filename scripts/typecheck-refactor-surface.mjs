import { spawnSync } from "node:child_process";

const surfaceFiles = [
  "web/app/codex-deck-app.tsx",
  "web/hooks/use-codex-memories.ts",
  "web/hooks/use-codex-pets.ts",
  "web/hooks/use-session-hooks-pane.ts",
  "web/components/diff-pane.tsx",
  "web/components/hooks-pane.tsx",
  "web/components/memories-modal.tsx",
  "web/transport/types.ts",
  "web/transport/local.ts",
  "web/slash-commands.ts",
  "tests/unit/slash-commands.test.ts",
  "api/codex-app-server-hooks.ts",
  "api/server/hooks-routes.ts",
  "api/server/route-helpers.ts",
  "api/server/create-server.ts",
  "api/storage/hooks.ts",
];

const command = [
  "exec",
  "tsc",
  "--noEmit",
  "--pretty",
  "false",
  "-p",
  "tsconfig.test.json",
];

const result = spawnSync("pnpm", command, {
  cwd: process.cwd(),
  encoding: "utf8",
});

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
const combined = `${stdout}${stderr}`;

const relevantLines = combined
  .split(/\r?\n/)
  .filter((line) =>
    surfaceFiles.some((file) => line.includes(`${file}(`) || line.includes(`${file}:`)),
  );

if (relevantLines.length > 0) {
  process.stderr.write(`${relevantLines.join("\n")}\n`);
  process.exit(1);
}

if (result.status && result.status !== 0) {
  process.stdout.write(
    "typecheck-refactor-surface: ignored non-surface TypeScript errors\n",
  );
}

