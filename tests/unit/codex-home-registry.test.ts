import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexHomeRegistry,
  toCodexHomeDescriptor,
} from "../../api/codex-home-registry";

test("Codex home registry validates paths and resolves runtime fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-homes-"));
  const mainHome = join(root, "main");
  const workHome = join(root, "work");
  const fallbackHome = join(root, "fallback");
  await mkdir(join(workHome, "codex-deck"), { recursive: true });
  await mkdir(mainHome, { recursive: true });
  await mkdir(fallbackHome, { recursive: true });
  await writeFile(
    join(workHome, "codex-deck", "config.toml"),
    'translation_command = "work-command"\n',
  );

  try {
    const homes = buildCodexHomeRegistry({
      mainCodexHome: mainHome,
      mainConfig: {
        translationCommand: "main-command",
        codexHomes: {
          work: { path: workHome, label: "Work" },
          fallback: { path: fallbackHome },
          duplicate: { path: workHome },
          missing: { path: join(root, "missing") },
          main: { path: fallbackHome },
          "bad.id": { path: fallbackHome },
          noPath: { label: "No path" },
        },
      },
    });

    assert.deepEqual(
      homes.map(({ id, available }) => ({ id, available })),
      [
        { id: "main", available: true },
        { id: "work", available: true },
        { id: "fallback", available: true },
        { id: "duplicate", available: false },
        { id: "missing", available: false },
        { id: "main", available: false },
        { id: "bad.id", available: false },
        { id: "noPath", available: false },
      ],
    );
    assert.equal(homes[1]?.translationCommand, "work-command");
    assert.equal(homes[2]?.translationCommand, "main-command");
    assert.match(homes[3]?.unavailableReason ?? "", /another Codex home/i);
    assert.match(homes[4]?.unavailableReason ?? "", /does not exist/i);
    assert.match(homes[5]?.unavailableReason ?? "", /reserved/i);
    assert.match(homes[6]?.unavailableReason ?? "", /letters, numbers/i);
    assert.match(homes[7]?.unavailableReason ?? "", /path is required/i);

    assert.deepEqual(toCodexHomeDescriptor(homes[1]!), {
      id: "work",
      label: "Work",
      isMain: false,
      available: true,
      unavailableReason: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
