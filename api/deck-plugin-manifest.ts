export const DECK_PLUGIN_PACKAGE_MAX_BYTES = 8 * 1024 * 1024;
export const DECK_PLUGIN_PACKAGE_MAX_FILES = 256;
export const DECK_PLUGIN_MANIFEST_MAX_BYTES = 128 * 1024;
export const DECK_PLUGIN_STATE_MAX_BYTES = 64 * 1024;

export const DECK_PLUGIN_CAPABILITIES = [
  "context.read",
  "state.read",
  "state.write",
] as const;

export type DeckPluginCapability = (typeof DECK_PLUGIN_CAPABILITIES)[number];
export type DeckPluginState = Record<string, unknown>;

export interface DeckPluginManifest {
  schemaVersion: 1;
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  capabilities: DeckPluginCapability[];
  entrypoints: { panel: string };
}

export interface DeckPluginRuntimeResponse {
  plugin: { id: string; name: string; version: string };
  manifest: DeckPluginManifest;
  state: DeckPluginState;
}

export interface DeckPluginSourceFile {
  path: string;
  size: number;
  content: string | null;
}

export interface DeckPluginSourceResponse {
  plugin: { id: string; name: string; version: string };
  manifest: DeckPluginManifest;
  files: DeckPluginSourceFile[];
}

export interface DeckPluginFileUpload {
  path: string;
  contentBase64: string;
}

export interface DeckPluginSummary {
  schemaVersion: 1;
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  capabilities: DeckPluginCapability[];
  entrypoints: { panel: string };
  source: "package" | "legacy";
  installed: boolean;
  enabled: boolean;
  hasExecutableUi: boolean;
}

export interface DeckPluginsSnapshot {
  plugins: DeckPluginSummary[];
}

export type DeckPluginInstallInput = {
  files: DeckPluginFileUpload[];
  replaceVersion?: string;
};

export class DeckPluginManifestError extends Error {}

function readObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeckPluginManifestError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new DeckPluginManifestError(
      `${field} must be nonempty text of at most ${maxLength} characters.`,
    );
  }
  return value.trim();
}

function readId(value: unknown, field: string): string {
  const id = readText(value, field, 80);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw new DeckPluginManifestError(
      `${field} must start with a lowercase letter and use lowercase letters, digits, dots, or hyphens.`,
    );
  }
  return id;
}

export function parseDeckPluginPath(value: unknown, field = "path"): string {
  const filePath = readText(value, field, 512);
  const segments = filePath.split("/");
  if (
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[\u0000-\u001f\u007f]/.test(segment),
    )
  ) {
    throw new DeckPluginManifestError(
      `${field} must be a relative package file path.`,
    );
  }
  return filePath;
}

export function parseDeckPluginManifest(value: unknown): DeckPluginManifest {
  const source = readObject(value, "Plugin manifest");
  if (source.schemaVersion !== 1) {
    throw new DeckPluginManifestError("This plugin requires schemaVersion 1.");
  }
  if (source.apiVersion !== 1) {
    throw new DeckPluginManifestError(
      "This plugin requires an unsupported Codex Deck plugin API version.",
    );
  }
  const version = readText(source.version, "version", 40);
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version)) {
    throw new DeckPluginManifestError(
      "version must look like 1.0.0 or 1.0.0-beta.",
    );
  }

  const capabilitiesValue = source.capabilities ?? [];
  if (
    !Array.isArray(capabilitiesValue) ||
    capabilitiesValue.some(
      (capability) =>
        typeof capability !== "string" ||
        !(DECK_PLUGIN_CAPABILITIES as readonly string[]).includes(capability),
    ) ||
    new Set(capabilitiesValue).size !== capabilitiesValue.length
  ) {
    throw new DeckPluginManifestError(
      `capabilities must be unique supported values: ${DECK_PLUGIN_CAPABILITIES.join(", ")}.`,
    );
  }

  const entrypoints = readObject(source.entrypoints, "entrypoints");
  const panel = parseDeckPluginPath(entrypoints.panel, "entrypoints.panel");
  if (!/\.html?$/i.test(panel)) {
    throw new DeckPluginManifestError(
      "entrypoints.panel must point to an HTML file.",
    );
  }

  return {
    schemaVersion: 1,
    apiVersion: 1,
    id: readId(source.id, "id"),
    name: readText(source.name, "name", 80),
    version,
    description: readText(source.description, "description", 400),
    ...(source.author === undefined
      ? {}
      : { author: readText(source.author, "author", 80) }),
    capabilities: capabilitiesValue as DeckPluginCapability[],
    entrypoints: { panel },
  };
}

export function summarizeDeckPlugin(
  manifest: DeckPluginManifest,
  source: DeckPluginSummary["source"],
  enabled: boolean,
): DeckPluginSummary {
  return {
    ...manifest,
    source,
    installed: true,
    enabled,
    hasExecutableUi: true,
  };
}
