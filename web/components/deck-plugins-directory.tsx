import { ArrowLeft, FileUp, Puzzle, Search } from "lucide-react";
import { useRef, useState } from "react";
import {
  DECK_PLUGIN_PACKAGE_MAX_BYTES,
  DECK_PLUGIN_MANIFEST_MAX_BYTES,
  parseDeckPluginManifest,
  summarizeDeckPlugin,
  type DeckPluginFileUpload,
  type DeckPluginManifest,
  type DeckPluginsSnapshot,
  type DeckPluginSummary,
} from "../../api/deck-plugin-manifest";
import {
  getDeckPluginSource,
  installDeckPlugin,
  listDeckPlugins,
  setDeckPluginEnabled,
  uninstallDeckPlugin,
} from "../deck-plugins-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import DeckPluginRuntime from "./deck-plugin-runtime";

const secondaryButton =
  "inline-flex min-h-8 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-800 disabled:opacity-50";
const primaryButton =
  "inline-flex min-h-8 items-center justify-center rounded-md bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-950 hover:bg-zinc-200 disabled:opacity-50";

interface ImportedPluginPackage {
  manifest: DeckPluginManifest;
  files: DeckPluginFileUpload[];
  totalBytes: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

function decodeBase64Text(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function previewText(value: string): string {
  try {
    return decodeBase64Text(value);
  } catch {
    return "This file is not valid UTF-8 text.";
  }
}

function isTextPackageFile(path: string): boolean {
  return /\.(?:html?|css|[cm]?js|json|md|txt|svg)$/i.test(path);
}

async function readPluginPackage(
  files: FileList | File[] | null,
): Promise<ImportedPluginPackage> {
  const selected = [...(files ?? [])];
  if (selected.length === 0) throw new Error("Select a plugin package folder.");
  if (selected.length > 256) {
    throw new Error("A plugin package can contain at most 256 files.");
  }
  const relativePaths = selected.map((file) => file.webkitRelativePath);
  const hasRelativePaths = relativePaths.every(Boolean);
  if (!hasRelativePaths && relativePaths.some(Boolean)) {
    throw new Error("Choose files from a single plugin package folder.");
  }
  const folderName = hasRelativePaths
    ? relativePaths[0]?.split("/")[0]
    : undefined;
  let totalBytes = 0;
  const uploads: DeckPluginFileUpload[] = [];
  for (const file of selected) {
    const parts = hasRelativePaths
      ? file.webkitRelativePath.split("/")
      : [file.name];
    if (
      (hasRelativePaths && parts[0] !== folderName) ||
      (hasRelativePaths && parts.length < 2)
    ) {
      throw new Error("Choose exactly one plugin package folder.");
    }
    const path = hasRelativePaths ? parts.slice(1).join("/") : file.name;
    if (path === "plugin.json" && file.size > DECK_PLUGIN_MANIFEST_MAX_BYTES) {
      throw new Error("plugin.json can be at most 128 KiB.");
    }
    totalBytes += file.size;
    if (totalBytes > DECK_PLUGIN_PACKAGE_MAX_BYTES) {
      throw new Error("Plugin packages can be at most 8 MiB.");
    }
    uploads.push({
      path,
      contentBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    });
  }
  const manifestUpload = uploads.find((file) => file.path === "plugin.json");
  if (!manifestUpload) {
    throw new Error(
      "The selected folder must contain plugin.json at its root.",
    );
  }
  const manifest = parseDeckPluginManifest(
    JSON.parse(decodeBase64Text(manifestUpload.contentBase64)),
  );
  for (const [kind, path] of Object.entries(manifest.entrypoints)) {
    if (!uploads.some((file) => file.path === path))
      throw new Error(
        `The ${kind} entrypoint "${path}" is missing from the selected folder.`,
      );
  }
  return { manifest, files: uploads, totalBytes };
}

function pluginStatus(plugin: DeckPluginSummary) {
  return plugin.enabled ? "Enabled" : "Disabled";
}

export default function DeckPluginsDirectory({
  threadId,
  cwd,
}: {
  threadId: string | null;
  cwd: string | null;
}) {
  const { data, loading, error, refresh, setData } = useNativeSnapshot(
    "deck-plugins",
    null,
    listDeckPlugins,
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportedPluginPackage | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [openedPluginId, setOpenedPluginId] = useState<string | null>(null);
  const [reviewedPlugin, setReviewedPlugin] = useState<{
    id: string;
    files: Array<{ path: string; size: number; content: string | null }>;
  } | null>(null);
  const [reviewingCode, setReviewingCode] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const plugins = data?.plugins ?? [];
  const existing = imported
    ? plugins.find((plugin) => plugin.id === imported.manifest.id)
    : undefined;
  const selected = imported
    ? {
        ...summarizeDeckPlugin(imported.manifest, "package", false),
        installed: false,
      }
    : plugins.find((plugin) => plugin.id === selectedId);
  const sameVersion =
    imported && existing?.version === imported.manifest.version;
  const term = query.trim().toLowerCase();
  const matches = plugins.filter((plugin) =>
    [plugin.name, plugin.description, plugin.author, plugin.id].some((value) =>
      value?.toLowerCase().includes(term),
    ),
  );

  const update = async (
    change: () => Promise<DeckPluginsSnapshot>,
    after?: () => void,
  ) => {
    setBusy(true);
    setActionError("");
    try {
      setData(await change());
      after?.();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      refresh();
      setBusy(false);
    }
  };

  const readPackage = async (files: FileList | File[] | null) => {
    setReadingFile(true);
    setActionError("");
    try {
      const pluginPackage = await readPluginPackage(files);
      setSelectedId(null);
      setReviewConfirmed(false);
      setImported(pluginPackage);
    } catch (reason) {
      setActionError(
        reason instanceof SyntaxError
          ? "plugin.json does not contain valid JSON."
          : reason instanceof Error
            ? reason.message
            : String(reason),
      );
    } finally {
      setReadingFile(false);
    }
  };

  const contents = (
    <div className="space-y-4">
      {error && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 text-sm"
          role="alert"
        >
          <span className="text-rose-300">{error}</span>
          <button className={secondaryButton} type="button" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <p className="break-words text-sm text-rose-300" role="alert">
          {actionError}
        </p>
      )}
      <input
        ref={(input) => {
          fileInput.current = input;
          input?.setAttribute("webkitdirectory", "");
          input?.setAttribute("directory", "");
        }}
        type="file"
        multiple
        aria-label="Plugin package folder"
        className="hidden"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files?.length) void readPackage(files);
        }}
      />

      {selected ? (
        <div className="space-y-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setImported(null);
              setSelectedId(null);
              setOpenedPluginId(null);
              setReviewConfirmed(false);
              setActionError("");
            }}
            className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-100"
          >
            <ArrowLeft className="size-4" /> Back to plugins
          </button>
          <div>
            <h3 className="break-words text-lg font-semibold">
              {selected.name}
            </h3>
            <p className="mt-0.5 break-words text-xs text-zinc-400">
              {[
                selected.author,
                `v${selected.version}`,
                selected.source === "legacy" ? "Legacy plugin" : "Package",
                ...(!imported && selected.installed
                  ? [pluginStatus(selected)]
                  : []),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <p className="mt-2 break-words text-sm text-zinc-300">
              {selected.description}
            </p>
          </div>
          {imported && (
            <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
              <p>
                Entrypoints:{" "}
                <code>
                  {Object.entries(selected.entrypoints)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(", ")}
                </code>
              </p>
              <p>
                Requested capabilities:{" "}
                {selected.capabilities.length
                  ? selected.capabilities.join(", ")
                  : "none"}
              </p>
              <p>
                {imported.files.length} files ·{" "}
                {Math.ceil(imported.totalBytes / 1024)} KiB
              </p>
            </div>
          )}
          {selected.entrypoints.backend && (
            <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-700 dark:text-amber-200">
              Executable backend permission: this plugin runs trusted local
              Node.js code with your daemon’s filesystem and network access,
              independently of browser connections. Review all worker files
              before installing or updating.
            </p>
          )}
          {imported && (
            <details
              open
              className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"
            >
              <summary className="cursor-pointer text-sm text-zinc-300">
                Review package files ({imported.files.length})
              </summary>
              <ul className="mt-3 space-y-3">
                {imported.files.map((file) => (
                  <li key={file.path} className="min-w-0">
                    <p className="break-all text-xs font-medium text-zinc-300">
                      {file.path}
                    </p>
                    {isTextPackageFile(file.path) && (
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-900 p-2 text-xs text-zinc-400">
                        {previewText(file.contentBase64)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {imported && (
            <label className="flex items-start gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={reviewConfirmed}
                onChange={(event) =>
                  setReviewConfirmed(event.currentTarget.checked)
                }
                className="mt-0.5 accent-cyan-500"
              />
              <span>I reviewed the package source and trust this plugin.</span>
            </label>
          )}
          {sameVersion && (
            <p className="text-sm text-zinc-400">
              This version is already installed.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {imported ? (
              <button
                type="button"
                className={primaryButton}
                disabled={busy || !data || !!sameVersion || !reviewConfirmed}
                onClick={() =>
                  void update(
                    () =>
                      installDeckPlugin({
                        files: imported.files,
                        replaceVersion: existing?.version,
                      }),
                    () => {
                      setQuery("");
                      setSelectedId(imported.manifest.id);
                      setImported(null);
                    },
                  )
                }
              >
                {existing ? `Replace v${existing.version}` : "Install plugin"}
              </button>
            ) : selected.installed ? (
              <>
                {selected.enabled && selected.hasExecutableUi && (
                  <button
                    type="button"
                    className={primaryButton}
                    disabled={busy}
                    onClick={() => setOpenedPluginId(selected.id)}
                  >
                    Open plugin
                  </button>
                )}
                {selected.hasExecutableUi && (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy || reviewingCode}
                    onClick={async () => {
                      if (reviewedPlugin?.id === selected.id) {
                        setReviewedPlugin(null);
                        return;
                      }
                      setReviewingCode(true);
                      setActionError("");
                      try {
                        const source = await getDeckPluginSource(selected.id);
                        setReviewedPlugin({
                          id: selected.id,
                          files: source.files,
                        });
                      } catch (reason) {
                        setActionError(
                          reason instanceof Error
                            ? reason.message
                            : String(reason),
                        );
                      } finally {
                        setReviewingCode(false);
                      }
                    }}
                  >
                    {reviewingCode
                      ? "Loading code…"
                      : reviewedPlugin?.id === selected.id
                        ? "Hide code"
                        : "Review plugin code"}
                  </button>
                )}
                {selected.source !== "legacy" && (
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy}
                    onClick={() =>
                      void update(() =>
                        setDeckPluginEnabled(selected.id, !selected.enabled),
                      )
                    }
                  >
                    {selected.enabled ? "Disable" : "Enable"}
                  </button>
                )}
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() =>
                    void update(
                      () => uninstallDeckPlugin(selected.id),
                      () => setSelectedId(null),
                    )
                  }
                >
                  Uninstall
                </button>
              </>
            ) : null}
          </div>
          {reviewedPlugin?.id === selected.id && (
            <details
              open
              className="rounded-lg border border-zinc-800 bg-zinc-950 p-3"
            >
              <summary className="cursor-pointer text-sm text-zinc-300">
                Executable plugin code
              </summary>
              <div className="mt-2 max-h-56 space-y-3 overflow-auto whitespace-pre-wrap break-words text-xs text-zinc-400">
                {reviewedPlugin.files.map((file) => (
                  <span key={file.path} className="block">
                    <strong>{file.path}</strong>
                    {file.content === null ? (
                      <span className="ml-2 italic">
                        binary file · {file.size} bytes
                      </span>
                    ) : (
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-900 p-2 text-xs text-zinc-400">
                        {file.content}
                      </pre>
                    )}
                  </span>
                ))}
              </div>
            </details>
          )}
          {selected.installed && !selected.hasExecutableUi && (
            <p className="text-xs text-zinc-400">
              This plugin runs a backend worker without a browser panel.
            </p>
          )}
          {openedPluginId === selected.id && selected.enabled && (
            <DeckPluginRuntime
              key={selected.id}
              pluginId={selected.id}
              context={{ threadId, cwd }}
              onClose={() => setOpenedPluginId(null)}
            />
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-zinc-400">
              Installed ({plugins.length})
            </span>
            <button
              type="button"
              className={secondaryButton}
              disabled={readingFile}
              onClick={() => fileInput.current?.click()}
            >
              <FileUp className="size-4" />
              {readingFile ? "Reading package…" : "Import plugin folder"}
            </button>
          </div>
          <p className="text-xs text-zinc-400">
            A plugin is a folder with <code>plugin.json</code>, its panel HTML,
            JavaScript, styles, and any local assets.
          </p>
          <label className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950 px-3 focus-within:border-cyan-500">
            <Search className="size-4 shrink-0 text-zinc-400" />
            <input
              type="search"
              value={query}
              aria-label="Search Deck plugins"
              placeholder="Search plugins"
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="min-h-9 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-zinc-500"
            />
          </label>
          {loading && !data && (
            <p className="p-2 text-sm text-zinc-400" role="status">
              Loading plugins…
            </p>
          )}
          {data && matches.length === 0 && (
            <p className="rounded-lg border border-dashed border-zinc-700 p-4 text-sm text-zinc-400">
              {term
                ? "No plugins match your search."
                : "No Codex Deck plugins are installed. Import a plugin folder to add one."}
            </p>
          )}
          <ul className="grid gap-2 sm:grid-cols-2">
            {matches.map((plugin) => (
              <li key={plugin.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    setActionError("");
                    setSelectedId(plugin.id);
                  }}
                  className="h-full w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-800/55 focus-visible:outline-2 focus-visible:outline-cyan-500"
                >
                  <span className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-cyan-950 text-cyan-400">
                      <Puzzle className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-semibold">
                        {plugin.name}
                      </span>
                      <span
                        className={`mt-1 inline-flex rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-300`}
                      >
                        Codex Deck
                      </span>
                      <span
                        className={`mt-1 block text-xs ${plugin.enabled ? "text-emerald-400" : "text-zinc-400"}`}
                      >
                        {pluginStatus(plugin)}
                      </span>
                    </span>
                  </span>
                  <span className="mt-2 block break-words text-sm text-zinc-400">
                    {plugin.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
  return (
    <section className="space-y-3 rounded-lg border border-cyan-500/25 bg-cyan-950/10 p-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">
            Codex Deck plugins
          </h3>
          <p className="mt-0.5 text-xs text-zinc-400">
            Installed plugin packages and settings for this Codex home.
          </p>
        </div>
        <span className="inline-flex rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-300">
          Codex Deck
        </span>
      </header>
      {contents}
    </section>
  );
}
