import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, normalize, resolve } from "node:path";
import type {
  CodexPetAnimation,
  CodexPetMetadata,
  CodexPetsResponse,
  CodexPetSelectionResponse,
} from "./storage";
import { getCodexDir } from "./storage";
import { isPathWithinDirectory } from "./path-utils";

const DEFAULT_FRAME_WIDTH = 192;
const DEFAULT_FRAME_HEIGHT = 208;
const DEFAULT_COLUMNS = 8;
const DEFAULT_ROWS = 9;
const DEFAULT_PET_ID = "codex";
export const DISABLED_PET_ID = "disabled";
const PET_CDN_BASE_URL = "https://persistent.oaistatic.com/codex/pets/v1";
const PET_CACHE_DIR = "cache/tui-pets/assets";
const PET_DIRECTIVE_COMMENT =
  "# Managed by codex-deck. Mirrors Codex CLI tui_pet selection.";

interface BuiltinPet {
  id: string;
  displayName: string;
  description: string;
  spritesheetFile: string;
}

interface PetManifest {
  id?: unknown;
  displayName?: unknown;
  display_name?: unknown;
  description?: unknown;
  spritesheetPath?: unknown;
  spritesheet_path?: unknown;
  frameWidth?: unknown;
  frame_width?: unknown;
  frameHeight?: unknown;
  frame_height?: unknown;
  frame?: unknown;
  columns?: unknown;
  rows?: unknown;
  animations?: unknown;
}

interface ResolvedPet {
  metadata: CodexPetMetadata;
  spritesheetPath: string | null;
}

const BUILTIN_PETS: BuiltinPet[] = [
  {
    id: "codex",
    displayName: "Codex",
    description: "The original Codex companion",
    spritesheetFile: "codex-spritesheet-v4.webp",
  },
  {
    id: "dewey",
    displayName: "Dewey",
    description: "A tidy duck for calm workspace days",
    spritesheetFile: "dewey-spritesheet-v4.webp",
  },
  {
    id: "fireball",
    displayName: "Fireball",
    description: "Hot path energy for fast iteration",
    spritesheetFile: "fireball-spritesheet-v4.webp",
  },
  {
    id: "rocky",
    displayName: "Rocky",
    description: "A steady rock when the diff gets large",
    spritesheetFile: "rocky-spritesheet-v4.webp",
  },
  {
    id: "seedy",
    displayName: "Seedy",
    description: "Small green shoots for new ideas",
    spritesheetFile: "seedy-spritesheet-v4.webp",
  },
  {
    id: "stacky",
    displayName: "Stacky",
    description: "A balanced stack for deep work",
    spritesheetFile: "stacky-spritesheet-v4.webp",
  },
  {
    id: "bsod",
    displayName: "BSOD",
    description: "A tiny blue-screen companion",
    spritesheetFile: "bsod-spritesheet-v4.webp",
  },
  {
    id: "null-signal",
    displayName: "Null Signal",
    description: "Quiet signal from the void",
    spritesheetFile: "null-signal-spritesheet-v4.webp",
  },
];

const DEFAULT_ANIMATIONS: CodexPetAnimation[] = [
  {
    name: "idle",
    frames: [
      { spriteIndex: 0, delayMs: 1680 },
      { spriteIndex: 1, delayMs: 660 },
      { spriteIndex: 2, delayMs: 660 },
      { spriteIndex: 3, delayMs: 840 },
      { spriteIndex: 4, delayMs: 840 },
      { spriteIndex: 5, delayMs: 1920 },
    ],
  },
];

export function normalizePetSelection(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("petId is required");
  }
  const lower = trimmed.toLowerCase();
  if (
    lower === "disable" ||
    lower === "disabled" ||
    lower === "hide" ||
    lower === "hidden" ||
    lower === "off" ||
    lower === "none"
  ) {
    return DISABLED_PET_ID;
  }
  return trimmed;
}

export async function listCodexPets(): Promise<CodexPetsResponse> {
  const codexHome = resolveCodexHome();
  const currentPetId = await readConfiguredPetId(codexHome);
  const pets = await listResolvedPets(codexHome);
  return {
    currentPetId,
    disabledPetId: DISABLED_PET_ID,
    pets: pets.map((pet) => pet.metadata),
  };
}

export async function selectCodexPet(
  rawPetId: string,
): Promise<CodexPetSelectionResponse> {
  const petId = normalizePetSelection(rawPetId);
  const codexHome = resolveCodexHome();
  const resolved =
    petId === DISABLED_PET_ID
      ? null
      : await resolvePetById(codexHome, petId, { ensureBuiltin: true });
  if (petId !== DISABLED_PET_ID && !resolved) {
    throw new Error(`Unknown pet: ${petId}`);
  }

  await writeConfiguredPetId(codexHome, petId);
  return {
    currentPetId: petId,
    pet: resolved?.metadata ?? null,
  };
}

export async function resolveCodexPetAsset(
  rawPetId: string,
): Promise<{ path: string; contentType: string }> {
  const petId = normalizePetSelection(rawPetId);
  if (petId === DISABLED_PET_ID) {
    throw new Error("Disabled pet has no spritesheet");
  }
  const codexHome = resolveCodexHome();
  const resolved = await resolvePetById(codexHome, petId, {
    ensureBuiltin: true,
  });
  if (!resolved?.spritesheetPath) {
    throw new Error(`Unknown pet: ${petId}`);
  }
  return {
    path: resolved.spritesheetPath,
    contentType: contentTypeForPath(resolved.spritesheetPath),
  };
}

async function listResolvedPets(codexHome: string): Promise<ResolvedPet[]> {
  const pets = [
    disabledPet(),
    ...BUILTIN_PETS.map((pet) => builtinPetMetadata(codexHome, pet)),
    ...(await listCustomPets(codexHome)),
  ];
  const [disabled, ...rest] = pets;
  rest.sort((left, right) =>
    left.metadata.displayName.localeCompare(right.metadata.displayName),
  );
  return [disabled, ...rest];
}

async function resolvePetById(
  codexHome: string,
  petId: string,
  options: { ensureBuiltin: boolean },
): Promise<ResolvedPet | null> {
  const builtin = BUILTIN_PETS.find((pet) => pet.id === petId);
  if (builtin) {
    if (options.ensureBuiltin) {
      await ensureBuiltinPetAsset(codexHome, builtin);
    }
    return builtinPetMetadata(codexHome, builtin);
  }
  const customPets = await listCustomPets(codexHome);
  return (
    customPets.find(
      (pet) =>
        pet.metadata.id === petId ||
        pet.metadata.id === customPetSelector(petId),
    ) ?? null
  );
}

function disabledPet(): ResolvedPet {
  return {
    spritesheetPath: null,
    metadata: {
      id: DISABLED_PET_ID,
      displayName: "Disable terminal pets",
      description: null,
      source: "disabled",
      spritesheetUrl: null,
      frameWidth: DEFAULT_FRAME_WIDTH,
      frameHeight: DEFAULT_FRAME_HEIGHT,
      columns: DEFAULT_COLUMNS,
      rows: DEFAULT_ROWS,
      animations: [],
    },
  };
}

function builtinPetMetadata(codexHome: string, pet: BuiltinPet): ResolvedPet {
  return {
    spritesheetPath: join(codexHome, PET_CACHE_DIR, pet.spritesheetFile),
    metadata: {
      id: pet.id,
      displayName: pet.displayName,
      description: pet.description,
      source: "builtin",
      spritesheetUrl: `/api/codex/pets/${encodeURIComponent(pet.id)}/spritesheet`,
      frameWidth: DEFAULT_FRAME_WIDTH,
      frameHeight: DEFAULT_FRAME_HEIGHT,
      columns: DEFAULT_COLUMNS,
      rows: DEFAULT_ROWS,
      animations: DEFAULT_ANIMATIONS,
    },
  };
}

async function listCustomPets(codexHome: string): Promise<ResolvedPet[]> {
  const pets = new Map<string, ResolvedPet>();
  for (const source of [
    { directory: "avatars", manifestFile: "avatar.json" },
    { directory: "pets", manifestFile: "pet.json" },
  ]) {
    const parent = join(codexHome, source.directory);
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === DISABLED_PET_ID || entry.name.startsWith("custom:")) {
        continue;
      }
      const petDir = join(parent, entry.name);
      const manifestPath = join(petDir, source.manifestFile);
      if (!existsSync(manifestPath)) {
        continue;
      }
      try {
        const pet = await loadCustomPet(petDir, manifestPath, entry.name);
        pets.set(pet.metadata.id, pet);
      } catch {
        continue;
      }
    }
  }
  return [...pets.values()];
}

async function loadCustomPet(
  petDir: string,
  manifestPath: string,
  fallbackId: string,
): Promise<ResolvedPet> {
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf-8"),
  ) as PetManifest;
  const rawId = asNonEmptyString(manifest.id) ?? fallbackId;
  const id = customPetSelector(rawId);
  const displayName =
    asNonEmptyString(manifest.displayName) ??
    asNonEmptyString(manifest.display_name) ??
    rawId;
  const description =
    asNonEmptyString(manifest.description) ?? "Custom pet";
  const spritesheetValue =
    asNonEmptyString(manifest.spritesheetPath) ??
    asNonEmptyString(manifest.spritesheet_path) ??
    "spritesheet.webp";
  const spritesheetPath = resolveManifestRelativePath(petDir, spritesheetValue);
  await stat(spritesheetPath);
  const frame = asRecord(manifest.frame);

  return {
    spritesheetPath,
    metadata: {
      id,
      displayName,
      description,
      source: "custom",
      spritesheetUrl: `/api/codex/pets/${encodeURIComponent(id)}/spritesheet`,
      frameWidth:
        asPositiveInteger(frame?.width) ??
        asPositiveInteger(manifest.frameWidth) ??
        asPositiveInteger(manifest.frame_width) ??
        DEFAULT_FRAME_WIDTH,
      frameHeight:
        asPositiveInteger(frame?.height) ??
        asPositiveInteger(manifest.frameHeight) ??
        asPositiveInteger(manifest.frame_height) ??
        DEFAULT_FRAME_HEIGHT,
      columns:
        asPositiveInteger(frame?.columns) ??
        asPositiveInteger(manifest.columns) ??
        DEFAULT_COLUMNS,
      rows:
        asPositiveInteger(frame?.rows) ??
        asPositiveInteger(manifest.rows) ??
        DEFAULT_ROWS,
      animations: parseAnimations(manifest.animations),
    },
  };
}

function resolveManifestRelativePath(petDir: string, value: string): string {
  if (value.startsWith("/") || value.includes("\0")) {
    throw new Error("spritesheet path must be relative");
  }
  const normalized = normalize(value);
  if (normalized === ".." || normalized.startsWith(`..`)) {
    throw new Error("spritesheet path must stay inside pet directory");
  }
  const resolved = resolve(petDir, normalized);
  if (!isPathWithinDirectory(resolved, resolve(petDir))) {
    throw new Error("spritesheet path must stay inside pet directory");
  }
  return resolved;
}

async function ensureBuiltinPetAsset(
  codexHome: string,
  pet: BuiltinPet,
): Promise<void> {
  const destination = join(codexHome, PET_CACHE_DIR, pet.spritesheetFile);
  if (existsSync(destination)) {
    return;
  }
  await mkdir(join(codexHome, PET_CACHE_DIR), { recursive: true });
  const url = `${PET_CDN_BASE_URL}/${pet.spritesheetFile}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download pet asset from ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, destination);
}

async function readConfiguredPetId(codexHome: string): Promise<string | null> {
  const configPath = join(codexHome, "config.toml");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return null;
  }
  return parseTopLevelTomlString(content, "tui_pet") ?? null;
}

async function writeConfiguredPetId(
  codexHome: string,
  petId: string,
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  let content = "";
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    content = "";
  }

  const nextLine = `tui_pet = ${JSON.stringify(petId)}`;
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^\s*tui_pet\s*=/.test(line)) {
      replaced = true;
      return nextLine;
    }
    return line;
  });
  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(PET_DIRECTIVE_COMMENT, nextLine);
  }
  const nextContent = `${nextLines.join("\n").replace(/\n+$/u, "")}\n`;
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, nextContent, "utf-8");
  await rename(tempPath, configPath);
}

function parseTopLevelTomlString(content: string, key: string): string | null {
  let inTable = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      inTable = true;
      continue;
    }
    if (inTable) {
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== key) {
      continue;
    }
    return parseTomlStringValue(match[2] ?? "");
  }
  return null;
}

function parseTomlStringValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) {
    return null;
  }
  let escaped = false;
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      try {
        return JSON.parse(trimmed.slice(0, index + 1)) as string;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseAnimations(value: unknown): CodexPetAnimation[] {
  if (!value || typeof value !== "object") {
    return DEFAULT_ANIMATIONS;
  }
  const animations: CodexPetAnimation[] = [];
  for (const [name, rawFrames] of Object.entries(value)) {
    if (!Array.isArray(rawFrames)) {
      continue;
    }
    const frames = rawFrames
      .map((frame) => {
        if (typeof frame === "number") {
          return { spriteIndex: frame, delayMs: 130 };
        }
        if (!frame || typeof frame !== "object") {
          return null;
        }
        const record = frame as Record<string, unknown>;
        const spriteIndex =
          asNonNegativeInteger(record.spriteIndex) ??
          asNonNegativeInteger(record.sprite_index) ??
          asNonNegativeInteger(record.index);
        if (spriteIndex === null) {
          return null;
        }
        return {
          spriteIndex,
          delayMs:
            asPositiveInteger(record.delayMs) ??
            asPositiveInteger(record.delay_ms) ??
            asPositiveInteger(record.durationMs) ??
            130,
        };
      })
      .filter(
        (
          frame,
        ): frame is {
          spriteIndex: number;
          delayMs: number;
        } => frame !== null,
      );
    if (frames.length > 0) {
      animations.push({ name, frames });
    }
  }
  return animations.length > 0 ? animations : DEFAULT_ANIMATIONS;
}

function customPetSelector(id: string): string {
  return id.startsWith("custom:") ? id : `custom:${id}`;
}

function resolveCodexHome(): string {
  return resolve(getCodexDir() || join(homedir(), ".codex"));
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function contentTypeForPath(path: string): string {
  const lower = basename(path).toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  return "application/octet-stream";
}

export function petAssetEtag(path: string): string {
  const stats = statSync(path);
  return createHash("sha256")
    .update(`${path}:${stats.size}:${stats.mtimeMs}`)
    .digest("hex")
    .slice(0, 16);
}
