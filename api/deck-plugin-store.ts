import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DECK_BUILTIN_PLUGINS } from "../builtin-plugins/catalog";
import type { DeckBuiltinPlugin } from "../builtin-plugins/types";
import {
  DECK_PLUGIN_STATE_MAX_BYTES,
  DeckPluginManifestError,
  parseDeckPluginManifest,
  parseDeckPluginPath,
  summarizeDeckPlugin,
  type DeckPluginManifest,
  type DeckPluginRuntimeResponse,
  type DeckPluginSourceFile,
  type DeckPluginSourceResponse,
  type DeckPluginState,
  type DeckPluginsSnapshot,
} from "./deck-plugin-manifest";
import {
  parseDeckPluginPackage,
  type ParsedDeckPluginPackage,
} from "./deck-plugin-package";

type InstalledPlugin =
  | { id: string; source: "package"; enabled: boolean }
  | { id: string; source: "builtin"; enabled: boolean }
  | { id: string; source: "legacy"; enabled: boolean };

const MAX_INSTALLED = 64;
const LEGACY_BUNDLE_PREFIX = "codex-deck.";
const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

function validPluginState(value: unknown): value is DeckPluginState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return (
      Buffer.byteLength(JSON.stringify(value), "utf8") <=
      DECK_PLUGIN_STATE_MAX_BYTES
    );
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function getMimeType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

function legacyManifest(id: string): DeckPluginManifest {
  return {
    schemaVersion: 1,
    id,
    name: id.slice(LEGACY_BUNDLE_PREFIX.length),
    version: "1.0.0",
    description: "This legacy built-in plugin is no longer available.",
    capabilities: [],
    entrypoints: { panel: "index.html" },
    author: "Codex Deck",
  };
}

export class DeckPluginError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
  }
}

export class DeckPluginStore {
  private changeRevision = 0;
  get revision(): number {
    return this.changeRevision;
  }
  private changed(): void {
    this.changeRevision++;
    this.onChange();
  }
  private readonly registryPath: string;
  private readonly packageRoot: string;
  private readonly dataRoot: string;
  readonly backendRoot: string;
  beforePackageChange: (id: string) => Promise<void> = async () => {};
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    codexHome: string,
    private readonly onChange: () => void,
    readonly builtins: readonly DeckBuiltinPlugin[] = DECK_BUILTIN_PLUGINS,
  ) {
    const root = join(codexHome, "codex-deck");
    this.registryPath = join(root, "plugins.json");
    this.packageRoot = join(root, "plugins");
    this.dataRoot = join(root, "plugin-data");
    this.backendRoot = join(root, "plugin-backend");
  }

  private async read(): Promise<Map<string, InstalledPlugin>> {
    let text: string;
    try {
      text = await readFile(this.registryPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    try {
      const entries: unknown = JSON.parse(text);
      if (
        !Array.isArray(entries) ||
        entries.length > MAX_INSTALLED + this.builtins.length
      ) {
        throw new Error("Invalid plugin list.");
      }
      const installed = new Map<string, InstalledPlugin>();
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry.id !== "string" ||
          !ID_PATTERN.test(entry.id) ||
          typeof entry.enabled !== "boolean" ||
          installed.has(entry.id)
        ) {
          throw new Error("Invalid installed plugin.");
        }
        if (
          (entry.source === "legacy" || entry.source === "bundled") &&
          entry.id.startsWith(LEGACY_BUNDLE_PREFIX)
        ) {
          installed.set(entry.id, {
            id: entry.id,
            source: "legacy",
            enabled: entry.enabled,
          });
        } else if (
          entry.source === "builtin" &&
          this.builtins.some((b) => b.manifest.id === entry.id)
        ) {
          installed.set(entry.id, {
            id: entry.id,
            source: "builtin",
            enabled: entry.enabled,
          });
        } else if (entry.source === "package") {
          installed.set(entry.id, {
            id: entry.id,
            source: "package",
            enabled: entry.enabled,
          });
        } else {
          throw new Error("Invalid plugin source.");
        }
      }
      return installed;
    } catch (error) {
      throw new Error("Could not read the Deck plugins registry.", {
        cause: error,
      });
    }
  }

  private async readManifest(id: string): Promise<DeckPluginManifest> {
    if (!ID_PATTERN.test(id))
      throw new DeckPluginError("Invalid plugin ID.", 404);
    const directory = resolve(this.packageRoot, id);
    if (!isWithin(resolve(this.packageRoot), directory)) {
      throw new DeckPluginError("Invalid plugin ID.", 404);
    }
    const manifestPath = join(directory, "plugin.json");
    try {
      const packageRootStat = await lstat(this.packageRoot);
      const stat = await lstat(directory);
      const manifestStat = await lstat(manifestPath);
      if (
        packageRootStat.isSymbolicLink() ||
        !packageRootStat.isDirectory() ||
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        manifestStat.isSymbolicLink() ||
        !manifestStat.isFile()
      ) {
        throw new Error("Plugin package files must be regular files.");
      }
      const manifest = parseDeckPluginManifest(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      if (manifest.id !== id) {
        throw new DeckPluginManifestError(
          "Plugin ID must match its installed directory name.",
        );
      }
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DeckPluginError("Plugin package is missing.", 404);
      }
      throw error;
    }
  }

  private async readPackageFiles(
    id: string,
  ): Promise<ParsedDeckPluginPackage["files"]> {
    const root = resolve(this.packageRoot, id);
    const packageRootStat = await lstat(this.packageRoot);
    const rootStat = await lstat(root);
    if (
      packageRootStat.isSymbolicLink() ||
      !packageRootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory()
    ) {
      throw new Error("Plugin package must be a regular directory.");
    }
    const files: ParsedDeckPluginPackage["files"] = [];
    const visit = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error("Plugin package files cannot be symbolic links.");
        }
        if (entry.isDirectory()) {
          await visit(path);
        } else if (entry.isFile()) {
          const packagePath = relative(root, path).split(sep).join("/");
          if (!isWithin(root, resolve(root, ...packagePath.split("/")))) {
            throw new Error("Plugin package file escapes its directory.");
          }
          files.push({ path: packagePath, bytes: await readFile(path) });
        }
      }
    };
    await visit(root);
    return files;
  }

  private async snapshot(
    installed: Map<string, InstalledPlugin>,
  ): Promise<DeckPluginsSnapshot> {
    const plugins = await Promise.all(
      [...installed.values()]
        .filter((entry) => entry.source !== "builtin")
        .map(async (entry) => {
          const manifest =
            entry.source === "package"
              ? await this.readManifest(entry.id)
              : legacyManifest(entry.id);
          const summary = summarizeDeckPlugin(
            manifest,
            entry.source === "package" ? "package" : "legacy",
            entry.enabled,
          );
          return {
            ...summary,
            hasExecutableUi:
              entry.source === "package" &&
              !!(
                manifest.entrypoints.panel ||
                manifest.entrypoints.settings ||
                manifest.contributions?.views?.length
              ),
          };
        }),
    );
    const bundled = this.builtins.map((definition) => ({
      ...summarizeDeckPlugin(
        parseDeckPluginManifest(definition.manifest, { builtin: true }),
        "builtin",
        definition.canDisable
          ? (installed.get(definition.manifest.id)?.enabled ??
              definition.defaultEnabled)
          : true,
      ),
      canDisable: definition.canDisable,
    }));
    return {
      plugins: [
        ...plugins.filter((plugin) => !bundled.some((b) => b.id === plugin.id)),
        ...bundled,
      ].sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async list(): Promise<DeckPluginsSnapshot> {
    await this.pending;
    return this.snapshot(await this.read());
  }

  private async writeRegistry(
    installed: Map<string, InstalledPlugin>,
  ): Promise<void> {
    if (
      [...installed.values()].filter((p) => p.source === "package").length >
      MAX_INSTALLED
    ) {
      throw new DeckPluginError(
        `A Codex home can have at most ${MAX_INSTALLED} installed plugins.`,
        409,
      );
    }
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.registryPath), { recursive: true });
    try {
      await writeFile(
        temporary,
        `${JSON.stringify([...installed.values()])}\n`,
        {
          mode: 0o600,
          flag: "wx",
        },
      );
      await rename(temporary, this.registryPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readState(id: string): Promise<DeckPluginState> {
    const path = join(this.dataRoot, `${id}.json`);
    try {
      const rootStat = await lstat(this.dataRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error("Plugin data directory must be a regular directory.");
      }
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error("Plugin state must be a regular file.");
      }
      const state: unknown = JSON.parse(await readFile(path, "utf8"));
      return validPluginState(state) ? state : {};
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      ) {
        return {};
      }
      throw error;
    }
  }

  private async removeState(id: string): Promise<void> {
    const path = join(this.dataRoot, `${id}.json`);
    try {
      const rootStat = await lstat(this.dataRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error("Plugin data directory must be a regular directory.");
      }
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error("Plugin state must be a regular file.");
      }
      await rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async writeState(id: string, state: DeckPluginState): Promise<void> {
    const path = join(this.dataRoot, `${id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true });
    const rootStat = await lstat(this.dataRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Plugin data directory must be a regular directory.");
    }
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private change(
    update: (installed: Map<string, InstalledPlugin>) => void | Promise<void>,
  ): Promise<DeckPluginsSnapshot> {
    const next = this.pending.then(async () => {
      const installed = await this.read();
      await update(installed);
      await this.writeRegistry(installed);
      this.changed();
      return this.snapshot(installed);
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  installPackage(
    value: unknown,
    replaceVersion: string | undefined,
  ): Promise<DeckPluginsSnapshot> {
    const parsed = parseDeckPluginPackage(value);
    const { manifest } = parsed;
    if (manifest.id.startsWith(LEGACY_BUNDLE_PREFIX)) {
      throw new DeckPluginError(
        `The ${LEGACY_BUNDLE_PREFIX} ID prefix is reserved for built-in plugins.`,
        400,
      );
    }
    const next = this.pending.then(async () => {
      const installed = await this.read();
      const existing = installed.get(manifest.id);
      const existingVersion =
        existing?.source === "package"
          ? (await this.readManifest(manifest.id)).version
          : undefined;
      if (existingVersion !== replaceVersion) {
        throw new DeckPluginError(
          "The installed plugin changed. Refresh and review it before installing.",
          409,
        );
      }
      if (existingVersion === manifest.version) {
        throw new DeckPluginError(
          "This plugin version is already installed.",
          409,
        );
      }
      if (
        !existing &&
        [...installed.values()].filter((p) => p.source === "package").length >=
          MAX_INSTALLED
      ) {
        throw new DeckPluginError(
          `A Codex home can have at most ${MAX_INSTALLED} installed plugins.`,
          409,
        );
      }

      await this.beforePackageChange(manifest.id);
      const packageRoot = resolve(this.packageRoot);
      await mkdir(packageRoot, { recursive: true });
      const packageRootStat = await lstat(packageRoot);
      if (packageRootStat.isSymbolicLink() || !packageRootStat.isDirectory()) {
        throw new Error(
          "Plugin packages directory must be a regular directory.",
        );
      }
      const target = resolve(packageRoot, manifest.id);
      if (!isWithin(packageRoot, target)) {
        throw new DeckPluginError("Invalid plugin ID.", 400);
      }
      const temporary = join(packageRoot, `.install-${randomUUID()}`);
      const backup = join(packageRoot, `.replace-${randomUUID()}`);
      let movedExisting = false;
      let movedNew = false;
      try {
        await mkdir(temporary, { mode: 0o700 });
        for (const file of parsed.files) {
          const destination = resolve(temporary, ...file.path.split("/"));
          if (!isWithin(temporary, destination)) {
            throw new DeckPluginManifestError("Package file escapes its root.");
          }
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, file.bytes, { mode: 0o600, flag: "wx" });
        }
        if (existing) {
          const targetStat = await lstat(target);
          if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
            throw new Error(
              "Installed plugin package must be a regular directory.",
            );
          }
          await rename(target, backup);
          movedExisting = true;
        }
        await rename(temporary, target);
        movedNew = true;
        installed.set(manifest.id, {
          id: manifest.id,
          source: "package",
          enabled: existing?.enabled ?? true,
        });
        await this.writeRegistry(installed);
      } catch (error) {
        if (movedNew) await rm(target, { recursive: true, force: true });
        if (movedExisting) await rename(backup, target).catch(() => undefined);
        throw error;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      if (movedExisting) await rm(backup, { recursive: true, force: true });
      this.changed();
      return this.snapshot(installed);
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  setEnabled(id: string, enabled: boolean): Promise<DeckPluginsSnapshot> {
    return this.change(async (installed) => {
      const builtin = this.builtins.find((b) => b.manifest.id === id);
      if (builtin && !builtin.canDisable && !enabled)
        throw new DeckPluginError(
          "This built-in plugin is required by Deck.",
          409,
        );
      const existing = installed.get(id);
      if (!existing && !builtin)
        throw new DeckPluginError("Plugin is not installed.", 404);
      await this.beforePackageChange(id);
      installed.set(
        id,
        existing
          ? { ...existing, enabled }
          : { id, source: "builtin", enabled },
      );
    });
  }

  uninstall(id: string): Promise<DeckPluginsSnapshot> {
    const next = this.pending.then(async () => {
      if (this.builtins.some((b) => b.manifest.id === id))
        throw new DeckPluginError(
          "Built-in plugins are shipped with Deck and cannot be uninstalled.",
          409,
        );
      const installed = await this.read();
      const existing = installed.get(id);
      if (!existing) throw new DeckPluginError("Plugin is not installed.", 404);
      await this.beforePackageChange(id);
      installed.delete(id);
      await this.writeRegistry(installed);
      if (existing.source === "package") {
        const target = resolve(this.packageRoot, id);
        if (!isWithin(resolve(this.packageRoot), target)) {
          throw new DeckPluginError("Invalid plugin ID.", 404);
        }
        await rm(target, { recursive: true, force: true });
        await this.removeState(id);
        await this.removeBackendData(id);
      }
      this.changed();
      return this.snapshot(installed);
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async removeBackendData(id: string): Promise<void> {
    await rm(join(this.backendRoot, id), { recursive: true, force: true });
  }

  async workerPath(id: string): Promise<string> {
    const runtime = await this.getRuntime(id);
    const path = runtime.manifest.entrypoints.backend;
    if (!path) throw new DeckPluginError("No backend entrypoint.", 400);
    // Validate the whole tree before Node can resolve relative imports.
    await this.readPackageFiles(id);
    return resolve(this.packageRoot, id, path);
  }

  async getRuntime(id: string): Promise<DeckPluginRuntimeResponse> {
    await this.pending;
    const builtin = this.builtins.find((b) => b.manifest.id === id);
    if (builtin) {
      const summary = (await this.list()).plugins.find((p) => p.id === id);
      if (!summary?.enabled)
        throw new DeckPluginError("Plugin is not enabled.", 404);
      return {
        plugin: {
          id,
          name: builtin.manifest.name,
          version: builtin.manifest.version,
        },
        manifest: parseDeckPluginManifest(builtin.manifest, { builtin: true }),
        state: await this.readState(id),
        source: "builtin",
      };
    }
    const entry = (await this.read()).get(id);
    if (!entry || entry.source !== "package" || !entry.enabled) {
      throw new DeckPluginError("Plugin is not enabled.", 404);
    }
    const manifest = await this.readManifest(id);
    for (const path of Object.values(manifest.entrypoints))
      await this.readPackageFile(id, path);
    for (const view of manifest.contributions?.views ?? []) {
      if (view.entrypoint) await this.readPackageFile(id, view.entrypoint);
    }
    return {
      plugin: { id, name: manifest.name, version: manifest.version },
      manifest,
      state: manifest.capabilities.includes("state.read")
        ? await this.readState(id)
        : {},
      source: "package",
    };
  }

  async readPackageFile(
    id: string,
    filePath: string,
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    const installed = (await this.read()).get(id);
    if (!installed || installed.source !== "package" || !installed.enabled) {
      throw new DeckPluginError("Plugin is not enabled.", 404);
    }
    let safePath: string;
    try {
      safePath = parseDeckPluginPath(filePath);
    } catch (error) {
      throw new DeckPluginError(
        error instanceof Error ? error.message : "Invalid package path.",
        404,
      );
    }
    const root = resolve(this.packageRoot, id);
    const target = resolve(root, ...safePath.split("/"));
    if (!ID_PATTERN.test(id) || !isWithin(root, target)) {
      throw new DeckPluginError("Plugin package file was not found.", 404);
    }
    try {
      const packageRootStat = await lstat(this.packageRoot);
      const rootStat = await lstat(root);
      if (
        packageRootStat.isSymbolicLink() ||
        !packageRootStat.isDirectory() ||
        rootStat.isSymbolicLink() ||
        !rootStat.isDirectory()
      ) {
        throw new DeckPluginError("Plugin package file was not found.", 404);
      }
      let current = root;
      for (const segment of safePath.split("/")) {
        current = join(current, segment);
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) {
          throw new DeckPluginError("Plugin package file was not found.", 404);
        }
        if (current !== target && !stat.isDirectory()) {
          throw new DeckPluginError("Plugin package file was not found.", 404);
        }
        if (current === target && !stat.isFile()) {
          throw new DeckPluginError("Plugin package file was not found.", 404);
        }
      }
      return { bytes: await readFile(target), mimeType: getMimeType(target) };
    } catch (error) {
      if (error instanceof DeckPluginError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DeckPluginError("Plugin package file was not found.", 404);
      }
      throw error;
    }
  }

  async getSource(id: string): Promise<DeckPluginSourceResponse> {
    const entry = (await this.read()).get(id);
    if (!entry || entry.source !== "package") {
      throw new DeckPluginError("Plugin is not installed.", 404);
    }
    const manifest = await this.readManifest(id);
    const files = await this.readPackageFiles(id);
    const sourceFiles: DeckPluginSourceFile[] = files.map((file) => {
      const mimeType = getMimeType(file.path);
      let content: string | null = null;
      if (
        mimeType.startsWith("text/") ||
        mimeType.includes("javascript") ||
        mimeType === "application/json" ||
        mimeType === "image/svg+xml"
      ) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            file.bytes,
          );
        } catch {
          content = null;
        }
      }
      return { path: file.path, size: file.bytes.byteLength, content };
    });
    return {
      plugin: { id, name: manifest.name, version: manifest.version },
      manifest,
      files: sourceFiles,
    };
  }

  setPluginState(id: string, state: unknown): Promise<DeckPluginsSnapshot> {
    if (!validPluginState(state)) {
      throw new DeckPluginError(
        `Plugin state must be a JSON object of at most ${DECK_PLUGIN_STATE_MAX_BYTES} bytes.`,
        400,
      );
    }
    const next = this.pending.then(async () => {
      const installed = await this.read();
      const entry = installed.get(id);
      if (!entry || entry.source !== "package" || !entry.enabled) {
        throw new DeckPluginError("Plugin is not enabled.", 404);
      }
      const manifest = await this.readManifest(id);
      if (!manifest.capabilities.includes("state.write"))
        throw new DeckPluginError("state.write is not granted.", 400);
      await this.writeState(id, state);
      this.changed();
      return this.snapshot(installed);
    });
    this.pending = next.catch(() => undefined);
    return next;
  }
}
