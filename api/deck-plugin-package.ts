import {
  DECK_PLUGIN_PACKAGE_MAX_BYTES,
  DECK_PLUGIN_PACKAGE_MAX_FILES,
  DECK_PLUGIN_MANIFEST_MAX_BYTES,
  DeckPluginManifestError,
  parseDeckPluginManifest,
  parseDeckPluginPath,
  type DeckPluginFileUpload,
  type DeckPluginManifest,
} from "./deck-plugin-manifest";

export interface ParsedDeckPluginFile {
  path: string;
  bytes: Buffer;
}

export interface ParsedDeckPluginPackage {
  manifest: DeckPluginManifest;
  files: ParsedDeckPluginFile[];
  totalBytes: number;
}

function decodeFile(value: unknown): ParsedDeckPluginFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeckPluginManifestError("Package files must be objects.");
  }
  const source = value as Record<string, unknown>;
  const filePath = parseDeckPluginPath(source.path);
  if (
    filePath
      .split("/")
      .some((segment) =>
        [".git", ".DS_Store", "node_modules"].includes(segment),
      )
  ) {
    throw new DeckPluginManifestError(
      `Package file "${filePath}" uses a reserved path.`,
    );
  }
  if (
    typeof source.contentBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      source.contentBase64,
    )
  ) {
    throw new DeckPluginManifestError(
      `Package file "${filePath}" must contain valid base64 data.`,
    );
  }
  return {
    path: filePath,
    bytes: Buffer.from(source.contentBase64, "base64"),
  };
}

export function parseDeckPluginPackage(
  value: unknown,
): ParsedDeckPluginPackage {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DeckPluginManifestError("Select a plugin package folder.");
  }
  if (value.length > DECK_PLUGIN_PACKAGE_MAX_FILES) {
    throw new DeckPluginManifestError(
      `A plugin package can contain at most ${DECK_PLUGIN_PACKAGE_MAX_FILES} files.`,
    );
  }

  const files = value.map(decodeFile);
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (paths.has(file.path)) {
      throw new DeckPluginManifestError(
        `Package contains duplicate file "${file.path}".`,
      );
    }
    paths.add(file.path);
    totalBytes += file.bytes.byteLength;
  }
  if (totalBytes > DECK_PLUGIN_PACKAGE_MAX_BYTES) {
    throw new DeckPluginManifestError(
      `Plugin packages can be at most ${DECK_PLUGIN_PACKAGE_MAX_BYTES / 1024 / 1024} MiB.`,
    );
  }

  const manifestFile = files.find((file) => file.path === "plugin.json");
  if (!manifestFile) {
    throw new DeckPluginManifestError(
      "A plugin package must contain plugin.json at its root.",
    );
  }
  if (manifestFile.bytes.byteLength > DECK_PLUGIN_MANIFEST_MAX_BYTES) {
    throw new DeckPluginManifestError("plugin.json can be at most 128 KiB.");
  }
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    throw new DeckPluginManifestError("plugin.json must contain valid JSON.");
  }
  const manifest = parseDeckPluginManifest(rawManifest);
  for (const [kind, path] of Object.entries(manifest.entrypoints)) {
    if (!paths.has(path))
      throw new DeckPluginManifestError(
        `The ${kind} entrypoint "${path}" is missing from the package.`,
      );
  }
  return { manifest, files, totalBytes };
}

export function encodeDeckPluginPackageFile(
  path: string,
  content: Buffer,
): DeckPluginFileUpload {
  return { path, contentBase64: content.toString("base64") };
}
