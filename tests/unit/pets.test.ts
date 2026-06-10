import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DISABLED_PET_ID,
  listCodexPets,
  normalizePetSelection,
  resolveCodexPetAsset,
  selectCodexPet,
} from "../../api/pets";
import { initStorage, invalidateHistoryCache } from "../../api/storage";
import { createTempCodexDir } from "./test-utils";

function setStorageDir(rootDir: string): void {
  initStorage(rootDir);
  invalidateHistoryCache();
}

async function writeCustomPet(rootDir: string): Promise<void> {
  const petDir = join(rootDir, "pets", "chefito");
  await mkdir(petDir, { recursive: true });
  await writeFile(join(petDir, "spritesheet.webp"), "fake", "utf-8");
  await writeFile(
    join(petDir, "pet.json"),
    JSON.stringify({
      id: "chefito",
      displayName: "Chefito",
      description: "custom pet",
      spritesheetPath: "spritesheet.webp",
      frame: {
        width: 32,
        height: 40,
        columns: 2,
        rows: 1,
      },
      animations: {
        idle: [
          { spriteIndex: 0, delayMs: 50 },
          { spriteIndex: 1, delayMs: 60 },
        ],
      },
    }),
    "utf-8",
  );
}

test("listCodexPets includes built-ins, disabled, and custom pets", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("pets-list");
  try {
    setStorageDir(rootDir);
    await writeCustomPet(rootDir);

    const response = await listCodexPets();
    assert.equal(response.disabledPetId, DISABLED_PET_ID);
    assert.equal(response.pets[0]?.id, DISABLED_PET_ID);
    const codex = response.pets.find((pet) => pet.id === "codex");
    assert.ok(codex);
    assert.deepEqual(
      codex.animations[0]?.frames.map((frame) => [
        frame.spriteIndex,
        frame.delayMs,
      ]),
      [
        [0, 1680],
        [1, 660],
        [2, 660],
        [3, 840],
        [4, 840],
        [5, 1920],
      ],
    );

    const custom = response.pets.find((pet) => pet.id === "custom:chefito");
    assert.ok(custom);
    assert.equal(custom.displayName, "Chefito");
    assert.equal(custom.frameWidth, 32);
    assert.equal(custom.animations[0]?.frames[1]?.delayMs, 60);
  } finally {
    await cleanup();
  }
});

test("selectCodexPet normalizes disable aliases and writes config", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("pets-disable");
  try {
    setStorageDir(rootDir);

    const response = await selectCodexPet("hide");
    assert.equal(response.currentPetId, DISABLED_PET_ID);
    assert.equal(response.pet, null);

    const config = await readFile(join(rootDir, "config.toml"), "utf-8");
    assert.match(config, /tui_pet = "disabled"/);
    assert.equal(normalizePetSelection("none"), DISABLED_PET_ID);
  } finally {
    await cleanup();
  }
});

test("resolveCodexPetAsset rejects custom spritesheet path traversal", async () => {
  const { rootDir, cleanup } = await createTempCodexDir("pets-path");
  try {
    setStorageDir(rootDir);
    const petDir = join(rootDir, "pets", "escape");
    await mkdir(petDir, { recursive: true });
    await writeFile(
      join(petDir, "pet.json"),
      JSON.stringify({
        id: "escape",
        displayName: "Escape",
        spritesheetPath: "../outside.webp",
      }),
      "utf-8",
    );

    await assert.rejects(
      () => resolveCodexPetAsset("custom:escape"),
      /Unknown pet: custom:escape/,
    );
  } finally {
    await cleanup();
  }
});
