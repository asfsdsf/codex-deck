import { useCallback, useState } from "react";
import type { CodexAppView } from "../../api/codex-plugins";
import { getCodexApps, setCodexAppEnabled } from "../extensions-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

const button =
  "min-h-9 rounded border border-zinc-700 px-3 py-1.5 disabled:opacity-50";

/** Explicit install/manage link for a ChatGPT app (connector). */
export function AppLink({
  app,
}: {
  app: Pick<CodexAppView, "installUrl" | "isAccessible">;
}) {
  if (!app.installUrl)
    return <span className="text-xs text-zinc-500">App link unavailable</span>;
  return (
    <a
      href={app.installUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-9 items-center rounded border border-cyan-500/40 px-3 py-1.5 text-cyan-300"
    >
      {app.isAccessible ? "Manage on ChatGPT" : "Install on ChatGPT"}
    </a>
  );
}

export default function AppsAdmin({ threadId }: { threadId: string | null }) {
  const [forceRefetch, setForceRefetch] = useState(false);
  const load = useCallback(
    () => getCodexApps(threadId, forceRefetch),
    [threadId, forceRefetch],
  );
  const { data, loading, error, refresh } = useNativeSnapshot(
    "apps",
    threadId,
    load,
  );
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const reload = () => {
    if (forceRefetch) refresh();
    else setForceRefetch(true);
  };

  const apps = data?.apps ?? [];
  const term = search.trim().toLowerCase();
  const visible = term
    ? apps.filter((app) =>
        `${app.name} ${app.id} ${app.description ?? ""}`
          .toLowerCase()
          .includes(term),
      )
    : apps;
  const installed = apps.filter((app) => app.isAccessible).length;

  const toggle = async (app: CodexAppView) => {
    setBusy(app.id);
    setActionError("");
    try {
      await setCodexAppEnabled(app.id, !app.isEnabled);
      refresh();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3 text-sm">
      {data?.enabled && (
        <p className="text-zinc-400">
          Installed {installed} of {apps.length} available apps. Install and
          sign in to apps on ChatGPT; newly installed apps can take a few
          minutes to appear.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={search}
          placeholder="Type to search apps"
          aria-label="Search apps"
          onChange={(event) => setSearch(event.target.value)}
          className="min-h-9 min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2"
        />
        <button
          type="button"
          disabled={loading}
          className={button}
          onClick={reload}
        >
          Reload apps
        </button>
      </div>
      {(error || actionError) && (
        <p role="alert" className="break-words text-red-400">
          {actionError || error}
        </p>
      )}
      {loading && !data && (
        <p role="status">Loading installed and available apps…</p>
      )}
      {data && !data.enabled && (
        <p className="text-amber-300">{data.disabledReason}</p>
      )}
      {data?.enabled && !apps.length && <p>No apps available.</p>}
      <ul className="space-y-2">
        {visible.map((app) => (
          <li
            key={app.id}
            className="min-w-0 space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
          >
            <div className="min-w-0">
              <p className="break-words font-semibold">{app.name}</p>
              <p className="break-words text-xs text-zinc-400">
                {app.statusLabel}
                {app.developer ? ` · ${app.developer}` : ""}
                {app.category ? ` · ${app.category}` : ""}
              </p>
              {app.description && (
                <p className="mt-1 line-clamp-3 break-words text-zinc-300">
                  {app.description}
                </p>
              )}
              {app.pluginDisplayNames.length > 0 && (
                <p className="mt-1 break-words text-xs text-zinc-500">
                  Used by plugins: {app.pluginDisplayNames.join(", ")}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                onClickCapture={() =>
                  setOpened((current) => new Set(current).add(app.id))
                }
              >
                <AppLink app={app} />
              </span>
              {app.isAccessible && (
                <button
                  type="button"
                  disabled={busy !== null}
                  className={button}
                  onClick={() => void toggle(app)}
                >
                  {busy === app.id
                    ? "Saving…"
                    : app.isEnabled
                      ? "Disable app"
                      : "Enable app"}
                </button>
              )}
              {!app.isAccessible && opened.has(app.id) && (
                <button
                  type="button"
                  disabled={loading}
                  className={button}
                  onClick={reload}
                >
                  I already installed it
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
