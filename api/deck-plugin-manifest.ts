export const DECK_PLUGIN_MANIFEST_MAX_BYTES = 128 * 1024;

export interface DeckPluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
}

export interface DeckPluginSummary extends DeckPluginManifest {
  source: "legacy" | "file";
  installed: boolean;
  enabled: boolean;
}

export interface DeckPluginsSnapshot {
  plugins: DeckPluginSummary[];
}

export type DeckPluginInstallInput = {
  manifest: DeckPluginManifest;
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

/** Parse non-executable plugin metadata on the host and in the browser. */
export function parseDeckPluginManifest(
  value: unknown,
  allowLegacyActions = false,
): DeckPluginManifest {
  const source = readObject(value, "Plugin manifest");
  if (source.schemaVersion !== 1) {
    throw new DeckPluginManifestError("This plugin requires schemaVersion 1.");
  }
  if ("actions" in source && !allowLegacyActions) {
    throw new DeckPluginManifestError(
      "Plugin manifests can include metadata only.",
    );
  }
  const version = readText(source.version, "version", 40);
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?(?:\+[\da-z.-]+)?$/i.test(version)) {
    throw new DeckPluginManifestError(
      "version must look like 1.0.0 or 1.0.0-beta.",
    );
  }
  const manifest: DeckPluginManifest = {
    schemaVersion: 1,
    id: readId(source.id, "id"),
    name: readText(source.name, "name", 80),
    version,
    description: readText(source.description, "description", 400),
    ...(source.author === undefined
      ? {}
      : { author: readText(source.author, "author", 80) }),
  };
  const size = new TextEncoder().encode(JSON.stringify(manifest)).byteLength;
  if (size > DECK_PLUGIN_MANIFEST_MAX_BYTES) {
    throw new DeckPluginManifestError(
      "Plugin manifests can be at most 128 KiB.",
    );
  }
  return manifest;
}

export function summarizeDeckPlugin(
  manifest: DeckPluginManifest,
  source: DeckPluginSummary["source"],
  installed: boolean,
  enabled: boolean,
): DeckPluginSummary {
  return {
    ...manifest,
    source,
    installed,
    enabled,
  };
}
