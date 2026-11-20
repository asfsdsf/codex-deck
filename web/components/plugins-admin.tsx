import { useCallback, useState } from "react";
import type {
  CodexPluginDetailView,
  CodexPluginView,
} from "../../api/codex-plugins";
import {
  addCodexMarketplace,
  getCodexPlugins,
  installCodexPlugin,
  readCodexPlugin,
  removeCodexMarketplace,
  searchCodexPlugins,
  setCodexPluginEnabled,
  uninstallCodexPlugin,
  upgradeCodexMarketplaces,
} from "../extensions-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";
import { AppLink } from "./apps-admin";

const button =
  "min-h-9 rounded border border-zinc-700 px-3 py-1.5 disabled:opacity-50";
const primary =
  "min-h-9 rounded bg-cyan-600 px-3 py-1.5 text-white disabled:opacity-50";
const field = "min-h-9 min-w-0 rounded border border-zinc-700 bg-zinc-950 px-2";

type Pending =
  | { kind: "install"; plugin: CodexPluginView }
  | { kind: "uninstall"; plugin: CodexPluginView }
  | { kind: "removeMarketplace"; name: string; displayName: string }
  | { kind: "addMarketplace"; source: string; refName: string };
interface AuthFlow {
  pluginName: string;
  apps: CodexPluginDetailView["apps"];
  index: number;
}

const target = (plugin: CodexPluginView) => ({
  pluginId: plugin.id,
  marketplaceName: plugin.marketplaceName,
});

export default function PluginsAdmin({ cwd }: { cwd: string | null }) {
  const [forceRefetch, setForceRefetch] = useState(false);
  const load = useCallback(
    () => getCodexPlugins(cwd, forceRefetch),
    [cwd, forceRefetch],
  );
  const { data, loading, error, refresh, setData } = useNativeSnapshot(
    "plugins",
    null,
    load,
  );
  const [tab, setTab] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [catalogMatches, setCatalogMatches] = useState<Set<string> | null>(
    null,
  );
  const [pending, setPending] = useState<Pending | null>(null);
  const [details, setDetails] = useState<CodexPluginDetailView | null>(null);
  const [authFlow, setAuthFlow] = useState<AuthFlow | null>(null);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [marketplaceRef, setMarketplaceRef] = useState("");

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setActionError("");
    setNotice("");
    try {
      await work();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
      refresh();
    } finally {
      setBusy("");
    }
  };

  const marketplaces = data?.marketplaces ?? [];
  const all = marketplaces.flatMap((marketplace) => marketplace.plugins);
  const installedCount = all.filter((plugin) => plugin.installed).length;
  const term = search.trim().toLowerCase();
  const matches = (plugin: CodexPluginView) =>
    !term ||
    catalogMatches?.has(plugin.id) ||
    [
      plugin.displayName,
      plugin.name,
      plugin.description ?? "",
      plugin.category ?? "",
      plugin.developer ?? "",
      ...plugin.keywords,
    ]
      .join(" ")
      .toLowerCase()
      .includes(term);
  const visible = (
    tab === "all"
      ? all
      : tab === "installed"
        ? all.filter((plugin) => plugin.installed)
        : (marketplaces.find((entry) => entry.name === tab)?.plugins ?? [])
  ).filter(matches);
  const selectedMarketplace = marketplaces.find((entry) => entry.name === tab);
  const marketplaceLabel = (name: string) =>
    marketplaces.find((entry) => entry.name === name)?.displayName ?? name;

  const confirm = () => {
    if (!pending) return;
    if (pending.kind === "install") {
      const plugin = pending.plugin;
      void act(`Installing ${plugin.displayName}…`, async () => {
        const result = await installCodexPlugin(cwd, target(plugin));
        setData(result.snapshot);
        setPending(null);
        if (result.appsNeedingAuth.length)
          setAuthFlow({
            pluginName: plugin.displayName,
            apps: result.appsNeedingAuth,
            index: 0,
          });
        else setNotice(`Installed ${plugin.displayName}.`);
      });
    } else if (pending.kind === "uninstall") {
      const plugin = pending.plugin;
      void act(`Uninstalling ${plugin.displayName}…`, async () => {
        setData(await uninstallCodexPlugin(cwd, target(plugin)));
        setPending(null);
        setDetails(null);
        setNotice(`Uninstalled ${plugin.displayName}.`);
      });
    } else if (pending.kind === "removeMarketplace") {
      const { name, displayName } = pending;
      void act(`Removing ${displayName}…`, async () => {
        setData(await removeCodexMarketplace(cwd, name));
        setPending(null);
        setTab("all");
        setNotice(`Removed ${displayName} marketplace.`);
      });
    } else {
      const { source, refName } = pending;
      void act("Adding marketplace…", async () => {
        const result = await addCodexMarketplace(cwd, source, refName || null);
        setData(result.snapshot);
        setPending(null);
        setMarketplaceSource("");
        setMarketplaceRef("");
        setTab(result.marketplaceName);
        setNotice(
          result.alreadyAdded
            ? `${result.marketplaceName} marketplace was already added.`
            : `Added ${result.marketplaceName} marketplace.`,
        );
      });
    }
  };

  return (
    <div className="space-y-3 text-sm">
      {data?.enabled && (
        <p className="text-zinc-400">
          Browse plugins from available marketplaces. Installed {installedCount}{" "}
          of {all.length} available plugins.
        </p>
      )}
      {(error || actionError) && (
        <p role="alert" className="break-words text-red-400">
          {actionError || error}
        </p>
      )}
      {busy && (
        <p role="status" className="text-zinc-400">
          {busy}
        </p>
      )}
      {notice && (
        <p role="status" className="text-emerald-300">
          {notice}
        </p>
      )}
      {loading && !data && <p role="status">Loading available plugins…</p>}
      {data && !data.enabled && (
        <p className="text-amber-300">{data.disabledReason}</p>
      )}

      {authFlow && authFlow.apps[authFlow.index] && (
        <section className="space-y-2 rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-3">
          <p className="font-semibold">
            App setup {authFlow.index + 1}/{authFlow.apps.length}:{" "}
            {authFlow.apps[authFlow.index].name}
          </p>
          <p className="text-xs text-zinc-400">
            {authFlow.pluginName} needs this app. Install it on ChatGPT, then
            continue.
          </p>
          <div className="flex flex-wrap gap-2">
            <AppLink
              app={{ ...authFlow.apps[authFlow.index], isAccessible: false }}
            />
            <button
              type="button"
              className={button}
              onClick={() => {
                if (authFlow.index + 1 < authFlow.apps.length) {
                  setAuthFlow({ ...authFlow, index: authFlow.index + 1 });
                  return;
                }
                setNotice(
                  `Completed app setup flow for ${authFlow.pluginName} plugin.`,
                );
                setAuthFlow(null);
              }}
            >
              I&apos;ve installed it
            </button>
            <button
              type="button"
              className={button}
              onClick={() => {
                setNotice(
                  `Skipped remaining app setup for ${authFlow.pluginName} plugin. The plugin may not be usable until required apps are installed.`,
                );
                setAuthFlow(null);
              }}
            >
              Skip remaining app setup
            </button>
          </div>
        </section>
      )}

      {pending && (
        <div
          role="alertdialog"
          aria-label="Confirm plugin change"
          className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
        >
          <p className="font-semibold">
            {pending.kind === "install"
              ? `Install ${pending.plugin.displayName}?`
              : pending.kind === "uninstall"
                ? `Uninstall ${pending.plugin.displayName}?`
                : pending.kind === "removeMarketplace"
                  ? `Remove ${pending.displayName} marketplace?`
                  : `Add marketplace from ${pending.source}?`}
          </p>
          <p className="break-words text-zinc-300">
            {pending.kind === "install"
              ? `From ${marketplaceLabel(pending.plugin.marketplaceName)} · ${pending.plugin.sourceSummary}. Installed plugins can add skills, apps, MCP servers, and hooks for every Codex client on this machine.`
              : pending.kind === "uninstall"
                ? "Remove this plugin now for every Codex client on this machine."
                : pending.kind === "removeMarketplace"
                  ? "This removes the configured marketplace from Codex."
                  : `Codex downloads the marketplace${pending.refName ? ` at ${pending.refName}` : ""} and adds it to your config.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(busy)}
              className="min-h-9 rounded bg-amber-600 px-3 py-1.5 text-white disabled:opacity-50"
              onClick={confirm}
            >
              {pending.kind === "install"
                ? "Install plugin"
                : pending.kind === "uninstall"
                  ? "Uninstall plugin"
                  : pending.kind === "removeMarketplace"
                    ? "Remove marketplace"
                    : "Add marketplace"}
            </button>
            <button
              type="button"
              className={button}
              onClick={() => setPending(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {data?.enabled && (
        <>
          <div
            role="tablist"
            aria-label="Plugin marketplaces"
            className="flex flex-wrap gap-1"
          >
            {[
              { id: "all", label: "All plugins" },
              { id: "installed", label: `Installed (${installedCount})` },
              ...marketplaces.map((entry) => ({
                id: entry.name,
                label: entry.displayName,
              })),
              { id: "add", label: "Add marketplace" },
            ].map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                onClick={() => {
                  setTab(entry.id);
                  setDetails(null);
                }}
                className={`min-h-9 rounded px-3 py-1.5 ${
                  tab === entry.id
                    ? "bg-zinc-700 text-zinc-100"
                    : "border border-zinc-700 text-zinc-300"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {tab === "add" ? (
            <form
              className="space-y-2 rounded-lg border border-zinc-700 p-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (marketplaceSource.trim())
                  setPending({
                    kind: "addMarketplace",
                    source: marketplaceSource.trim(),
                    refName: marketplaceRef.trim(),
                  });
              }}
            >
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">
                  Marketplace source (Git URL, owner/repo, or local path)
                </span>
                <input
                  value={marketplaceSource}
                  spellCheck={false}
                  onChange={(event) => setMarketplaceSource(event.target.value)}
                  className={`${field} w-full`}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">
                  Git ref (optional)
                </span>
                <input
                  value={marketplaceRef}
                  spellCheck={false}
                  onChange={(event) => setMarketplaceRef(event.target.value)}
                  className={`${field} w-full`}
                />
              </label>
              <button
                type="submit"
                disabled={Boolean(busy) || !marketplaceSource.trim()}
                className={primary}
              >
                Review marketplace
              </button>
            </form>
          ) : (
            <>
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!term) return setCatalogMatches(null);
                  void act("Searching plugins…", async () => {
                    const result = await searchCodexPlugins(cwd, search);
                    setCatalogMatches(
                      new Set(result.results.map((entry) => entry.pluginId)),
                    );
                  });
                }}
              >
                <input
                  type="search"
                  value={search}
                  aria-label="Search plugins"
                  placeholder="Type to search plugins"
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setCatalogMatches(null);
                  }}
                  className={`${field} flex-1`}
                />
                <button
                  type="submit"
                  disabled={Boolean(busy) || !term}
                  className={button}
                >
                  Search catalog
                </button>
                <button
                  type="button"
                  disabled={loading}
                  className={button}
                  onClick={() =>
                    forceRefetch ? refresh() : setForceRefetch(true)
                  }
                >
                  Refresh
                </button>
              </form>
              {selectedMarketplace && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                  {selectedMarketplace.path && (
                    <span className="min-w-0 break-all">
                      {selectedMarketplace.path}
                    </span>
                  )}
                  {selectedMarketplace.upgradable && (
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      className={button}
                      onClick={() =>
                        void act(
                          `Upgrading ${selectedMarketplace.displayName} marketplace…`,
                          async () => {
                            const result = await upgradeCodexMarketplaces(
                              cwd,
                              selectedMarketplace.name,
                            );
                            setData(result.snapshot);
                            setNotice(
                              result.errors.length
                                ? result.errors
                                    .map(
                                      (entry) =>
                                        `${entry.marketplaceName}: ${entry.message}`,
                                    )
                                    .join("; ")
                                : `Upgraded ${selectedMarketplace.displayName} marketplace.`,
                            );
                          },
                        )
                      }
                    >
                      Upgrade marketplace
                    </button>
                  )}
                  {selectedMarketplace.removable && (
                    <button
                      type="button"
                      disabled={Boolean(busy)}
                      className={button}
                      onClick={() =>
                        setPending({
                          kind: "removeMarketplace",
                          name: selectedMarketplace.name,
                          displayName: selectedMarketplace.displayName,
                        })
                      }
                    >
                      Remove marketplace
                    </button>
                  )}
                </div>
              )}
              {data.loadErrors.map((entry) => (
                <p
                  key={entry.marketplacePath}
                  className="break-words text-xs text-amber-300"
                >
                  {entry.marketplacePath}: {entry.message}
                </p>
              ))}
              {!visible.length && (
                <p className="text-zinc-400">
                  {all.length
                    ? "No plugins match this view."
                    : "No plugins are available in the discovered marketplaces."}
                </p>
              )}
              <ul className="space-y-2">
                {visible.map((plugin) => (
                  <li
                    key={`${plugin.marketplaceName}:${plugin.id}`}
                    className="min-w-0 space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
                  >
                    <div className="min-w-0">
                      <p className="break-words font-semibold">
                        {plugin.displayName}
                        {plugin.featured && (
                          <span className="ml-2 text-xs text-cyan-300">
                            Featured
                          </span>
                        )}
                      </p>
                      <p className="break-words text-xs text-zinc-400">
                        {plugin.statusLabel} ·{" "}
                        {marketplaceLabel(plugin.marketplaceName)}
                        {plugin.developer ? ` · ${plugin.developer}` : ""}
                      </p>
                      {plugin.description && (
                        <p className="mt-1 line-clamp-3 break-words text-zinc-300">
                          {plugin.description}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        className={button}
                        onClick={() =>
                          details?.plugin.id === plugin.id
                            ? setDetails(null)
                            : void act(
                                `Loading details for ${plugin.displayName}…`,
                                async () =>
                                  setDetails(
                                    await readCodexPlugin(cwd, target(plugin)),
                                  ),
                              )
                        }
                      >
                        {details?.plugin.id === plugin.id
                          ? "Hide details"
                          : "Details"}
                      </button>
                      {plugin.canInstall && (
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          className={primary}
                          onClick={() =>
                            setPending({ kind: "install", plugin })
                          }
                        >
                          Install
                        </button>
                      )}
                      {plugin.canToggle && (
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          className={button}
                          onClick={() =>
                            void act("Saving…", async () =>
                              setData(
                                await setCodexPluginEnabled(
                                  cwd,
                                  target(plugin),
                                  !plugin.enabled,
                                ),
                              ),
                            )
                          }
                        >
                          {plugin.enabled ? "Disable" : "Enable"}
                        </button>
                      )}
                      {plugin.canUninstall && (
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          className={button}
                          onClick={() =>
                            setPending({ kind: "uninstall", plugin })
                          }
                        >
                          Uninstall
                        </button>
                      )}
                      {!plugin.installed && plugin.installBlockedReason && (
                        <span className="self-center text-xs text-zinc-500">
                          {plugin.installBlockedReason}
                        </span>
                      )}
                      {plugin.installed &&
                        !plugin.canUninstall &&
                        plugin.uninstallBlockedReason && (
                          <span className="self-center text-xs text-zinc-500">
                            {plugin.uninstallBlockedReason}
                          </span>
                        )}
                    </div>
                    {details?.plugin.id === plugin.id && (
                      <div className="space-y-1 border-t border-zinc-700/60 pt-2 text-xs text-zinc-300">
                        {details.description && (
                          <p className="whitespace-pre-wrap break-words">
                            {details.description}
                          </p>
                        )}
                        <p className="break-all text-zinc-400">
                          Source: {plugin.sourceSummary}
                        </p>
                        {plugin.authPolicy && (
                          <p className="text-zinc-400">
                            Auth:{" "}
                            {plugin.authPolicy === "ON_INSTALL"
                              ? "on install"
                              : "on use"}
                          </p>
                        )}
                        {details.skills.length > 0 && (
                          <p>Skills: {details.skills.join(", ")}</p>
                        )}
                        {details.mcpServers.length > 0 && (
                          <p>MCP servers: {details.mcpServers.join(", ")}</p>
                        )}
                        {details.hooks.length > 0 && (
                          <p>Hooks: {details.hooks.join(", ")}</p>
                        )}
                        {details.apps.length > 0 && (
                          <div className="space-y-1">
                            <p>Apps:</p>
                            {details.apps.map((app) => (
                              <div
                                key={app.id}
                                className="flex flex-wrap items-center gap-2"
                              >
                                <span>{app.name}</span>
                                <AppLink
                                  app={{ ...app, isAccessible: false }}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="flex flex-wrap gap-3">
                          {[
                            ["Website", details.websiteUrl],
                            ["Privacy policy", details.privacyPolicyUrl],
                            ["Terms of service", details.termsOfServiceUrl],
                          ].map(([label, url]) =>
                            url ? (
                              <a
                                key={label}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-cyan-300 underline"
                              >
                                {label}
                              </a>
                            ) : null,
                          )}
                        </p>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
