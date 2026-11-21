import { ArrowLeft, FileUp, Puzzle, Search } from "lucide-react";
import { useRef, useState } from "react";
import {
  DECK_PLUGIN_MANIFEST_MAX_BYTES,
  parseDeckPluginManifest,
  summarizeDeckPlugin,
  type DeckPluginManifest,
  type DeckPluginsSnapshot,
  type DeckPluginSummary,
} from "../../api/deck-plugin-manifest";
import {
  installDeckPlugin,
  listDeckPlugins,
  setDeckPluginEnabled,
  uninstallDeckPlugin,
} from "../deck-plugins-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

const secondaryButton =
  "inline-flex min-h-8 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-800 disabled:opacity-50";
const primaryButton =
  "inline-flex min-h-8 items-center justify-center rounded-md bg-zinc-100 px-3 py-1 text-sm font-medium text-zinc-950 hover:bg-zinc-200 disabled:opacity-50";

function pluginStatus(plugin: DeckPluginSummary) {
  return plugin.enabled ? "Enabled" : "Disabled";
}

export default function DeckPluginsDirectory() {
  const { data, loading, error, refresh, setData } = useNativeSnapshot(
    "deck-plugins",
    null,
    listDeckPlugins,
  );
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imported, setImported] = useState<DeckPluginManifest | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const plugins = data?.plugins ?? [];
  const existing = imported
    ? plugins.find((plugin) => plugin.id === imported.id)
    : undefined;
  const selected = imported
    ? summarizeDeckPlugin(imported, "file", false, false)
    : plugins.find((plugin) => plugin.id === selectedId);
  const sameVersion = imported && existing?.version === imported.version;
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

  const readManifest = async (file: File) => {
    setReadingFile(true);
    setActionError("");
    try {
      if (file.size > DECK_PLUGIN_MANIFEST_MAX_BYTES) {
        throw new Error("Plugin manifests can be at most 128 KiB.");
      }
      const manifest = parseDeckPluginManifest(JSON.parse(await file.text()));
      setSelectedId(null);
      setImported(manifest);
    } catch (reason) {
      setActionError(
        reason instanceof SyntaxError
          ? "This file does not contain valid JSON."
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
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        aria-label="Plugin manifest"
        className="hidden"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void readManifest(file);
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
                selected.source === "legacy"
                  ? "Legacy plugin"
                  : "Manifest file",
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
                disabled={busy || !data || !!sameVersion}
                onClick={() =>
                  void update(
                    () =>
                      installDeckPlugin({
                        manifest: imported,
                        replaceVersion: existing?.version,
                      }),
                    () => {
                      setQuery("");
                      setSelectedId(imported.id);
                      setImported(null);
                    },
                  )
                }
              >
                {existing ? `Replace v${existing.version}` : "Install plugin"}
              </button>
            ) : selected.installed ? (
              <>
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
              {readingFile ? "Reading file…" : "Import manifest"}
            </button>
          </div>
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
                : "No Codex Deck plugins are installed. Import a manifest to add one."}
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
            Imported plugin metadata for this Codex home.
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
