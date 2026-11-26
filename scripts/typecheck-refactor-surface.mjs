import { spawnSync } from "node:child_process";

const surfaceFiles = [
  "api/deck-builtin-runtime.ts",
  "api/deck-plugin-manifest.ts",
  "api/deck-plugin-services.ts",
  "api/deck-plugin-store.ts",
  "api/deck-plugin-workers.ts",
  "api/server/deck-plugin-routes.ts",
  "api/diff-guide.ts",
  "api/diff-guide-store.ts",
  "api/server/diff-guide-routes.ts",
  "web/components/diff-guide-viewer.tsx",
  "web/components/session-delete-dialog.tsx",
  "builtin-plugins/sessions/client.tsx",
  "web/diff-guide-html.ts",
  "web/transport/remote.ts",
  "tests/unit/diff-guide.test.ts",
  "web/app/codex-deck-app.tsx",
  "web/components/message-composer.tsx",
  "web/components/remote-admin-app.tsx",
  "web/components/password-field.tsx",
  "web/detect-mobile-phone.ts",
  "web/remote-login.ts",
  "web/hooks/use-codex-memories.ts",
  "web/hooks/use-codex-pets.ts",
  "web/hooks/use-session-hooks-pane.ts",
  "builtin-plugins/right-pane/client.tsx",
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
  .filter(
    (line) =>
      (line.startsWith("builtin-plugins/") && !line.includes("TS6142")) ||
      surfaceFiles.some(
        (file) => line.includes(`${file}(`) || line.includes(`${file}:`),
      ),
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
