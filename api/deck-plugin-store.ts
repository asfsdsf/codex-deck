import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseDeckPluginManifest,
  summarizeDeckPlugin,
  type DeckPluginManifest,
  type DeckPluginsSnapshot,
} from "./deck-plugin-manifest";

type InstalledPlugin = { enabled: boolean } & (
  | { id: string; source: "bundled" }
  | { id: string; source: "file"; manifest: DeckPluginManifest }
);

const MAX_INSTALLED = 64;
const LEGACY_BUNDLE_PREFIX = "codex-deck.";
export class DeckPluginError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413,
  ) {
    super(message);
  }
}

export class DeckPluginStore {
  private readonly path: string;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(
    codexHome: string,
    private readonly onChange: () => void,
  ) {
    this.path = join(codexHome, "codex-deck", "plugins.json");
  }

  private async read(): Promise<Map<string, InstalledPlugin>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    try {
      const entries: unknown = JSON.parse(text);
      if (!Array.isArray(entries) || entries.length > MAX_INSTALLED) {
        throw new Error("Invalid plugin list.");
      }
      const installed = new Map<string, InstalledPlugin>();
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry.id !== "string" ||
          typeof entry.enabled !== "boolean" ||
          installed.has(entry.id)
        ) {
          throw new Error("Invalid installed plugin.");
        }
        if (
          entry.source === "bundled" &&
          entry.id.startsWith(LEGACY_BUNDLE_PREFIX)
        ) {
          installed.set(entry.id, {
            id: entry.id,
            source: "bundled",
            enabled: entry.enabled,
          });
        } else if (entry.source === "file") {
          const manifest = parseDeckPluginManifest(entry.manifest, true);
          if (
            manifest.id !== entry.id ||
            manifest.id.startsWith(LEGACY_BUNDLE_PREFIX)
          ) {
            throw new Error("Invalid installed plugin ID.");
          }
          installed.set(entry.id, {
            id: entry.id,
            source: "file",
            enabled: entry.enabled,
            manifest,
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

  private snapshot(
    installed: Map<string, InstalledPlugin>,
  ): DeckPluginsSnapshot {
    const plugins: DeckPluginsSnapshot["plugins"] = [];
    for (const entry of installed.values()) {
      if (entry.source === "file") {
        plugins.push(
          summarizeDeckPlugin(entry.manifest, "file", true, entry.enabled),
        );
      } else {
        plugins.push(
          summarizeDeckPlugin(
            {
              schemaVersion: 1,
              id: entry.id,
              name: entry.id.replace(LEGACY_BUNDLE_PREFIX, ""),
              version: "1.0.0",
              description:
                "This legacy built-in plugin is no longer available.",
              author: "Codex Deck",
            },
            "legacy",
            true,
            entry.enabled,
          ),
        );
      }
    }
    return {
      plugins: plugins.sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    };
  }

  async list(): Promise<DeckPluginsSnapshot> {
    return this.snapshot(await this.read());
  }

  private change(
    update: (installed: Map<string, InstalledPlugin>) => void,
  ): Promise<DeckPluginsSnapshot> {
    // Serialize read/modify/write across tabs. Rename keeps concurrent reads
    // on a complete snapshot even if the process stops during a write.
    const next = this.pending.then(async () => {
      const installed = await this.read();
      update(installed);
      if (installed.size > MAX_INSTALLED) {
        throw new DeckPluginError(
          `A Codex home can have at most ${MAX_INSTALLED} installed plugins.`,
          409,
        );
      }
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await mkdir(dirname(this.path), { recursive: true });
      try {
        await writeFile(
          temporary,
          JSON.stringify([...installed.values()]) + "\n",
          {
            mode: 0o600,
            flag: "wx",
          },
        );
        await rename(temporary, this.path);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.onChange();
      return this.snapshot(installed);
    });
    this.pending = next.catch(() => undefined);
    return next;
  }

  installFile(
    value: unknown,
    replaceVersion: string | undefined,
  ): Promise<DeckPluginsSnapshot> {
    const manifest = parseDeckPluginManifest(value);
    if (manifest.id.startsWith(LEGACY_BUNDLE_PREFIX)) {
      throw new DeckPluginError(
        `The ${LEGACY_BUNDLE_PREFIX} ID prefix is reserved for legacy plugins.`,
        400,
      );
    }
    return this.change((installed) => {
      const existing = installed.get(manifest.id);
      const version =
        existing?.source === "file" ? existing.manifest.version : undefined;
      if (version !== replaceVersion) {
        throw new DeckPluginError(
          "The installed plugin changed. Refresh and review it before installing.",
          409,
        );
      }
      if (version === manifest.version) {
        throw new DeckPluginError(
          "This plugin version is already installed.",
          409,
        );
      }
      installed.set(manifest.id, {
        id: manifest.id,
        source: "file",
        manifest,
        enabled: existing?.enabled ?? true,
      });
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<DeckPluginsSnapshot> {
    return this.change((installed) => {
      const existing = installed.get(id);
      if (!existing) throw new DeckPluginError("Plugin is not installed.", 404);
      installed.set(id, { ...existing, enabled });
    });
  }

  uninstall(id: string): Promise<DeckPluginsSnapshot> {
    return this.change((installed) => {
      if (!installed.delete(id))
        throw new DeckPluginError("Plugin is not installed.", 404);
    });
  }
}
