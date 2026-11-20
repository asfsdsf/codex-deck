import { useCallback, useState, type FormEvent } from "react";
import type { EnvironmentEntry, EnvironmentStatusKind } from "@codex-deck/api";
import {
  addCodexEnvironment,
  getCodexEnvironments,
  setCodexThreadEnvironmentSelection,
} from "../codex-organization-api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

const STATUS_CLASS: Record<EnvironmentStatusKind, string> = {
  ready: "border-emerald-500/40 text-emerald-300",
  pending: "border-amber-500/40 text-amber-300",
  disconnected: "border-red-500/40 text-red-300",
  unknown: "border-zinc-700 text-zinc-400",
};

const inputClass =
  "mt-1 w-full min-w-0 rounded border border-zinc-700 bg-zinc-950 p-2 text-zinc-100";

const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export function parseSkillList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((skill) => skill.trim())
        .filter(Boolean),
    ),
  ];
}

function EnvironmentRow({
  entry,
  threadId,
  busy,
  onSelect,
}: {
  entry: EnvironmentEntry;
  threadId: string | null;
  busy: boolean;
  onSelect: (environmentId: string, cwd: string) => void;
}) {
  const [cwd, setCwd] = useState(entry.cwd ?? "");
  const [choosing, setChoosing] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-all font-semibold">
          {entry.environmentId}
          {entry.builtIn && (
            <span className="ml-2 text-xs font-normal text-zinc-500">
              built-in
            </span>
          )}
        </p>
        <span
          className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${entry.status ? STATUS_CLASS[entry.status] : STATUS_CLASS.unknown}`}
        >
          {entry.status ?? "unavailable"}
        </span>
      </div>
      {entry.statusError && (
        <p className="break-words text-xs text-red-400">{entry.statusError}</p>
      )}
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        {entry.registration && (
          <>
            <dt className="text-zinc-500">Exec server</dt>
            <dd className="break-all text-zinc-300">
              {entry.registration.execServerUrl}
              {entry.registration.hasAuthToken ? " · bearer token set" : ""}
            </dd>
          </>
        )}
        {entry.registration?.requiredSkills.length ? (
          <>
            <dt className="text-zinc-500">Required skills</dt>
            <dd className="break-words text-zinc-300">
              {entry.registration.requiredSkills.join(", ")}
            </dd>
          </>
        ) : null}
        {entry.shell && (
          <>
            <dt className="text-zinc-500">Shell</dt>
            <dd className="break-all text-zinc-300">
              {entry.shell.name} ({entry.shell.path})
            </dd>
          </>
        )}
        {entry.cwd && (
          <>
            <dt className="text-zinc-500">Default directory</dt>
            <dd className="break-all text-zinc-300">{entry.cwd}</dd>
          </>
        )}
      </dl>
      {threadId &&
        (choosing ? (
          <div className="space-y-2">
            <label className="block text-xs text-zinc-400">
              Working directory in this environment
              <input
                className={inputClass}
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="/path/in/environment"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy || !cwd.trim()}
                onClick={() => {
                  onSelect(entry.environmentId, cwd.trim());
                  setChoosing(false);
                }}
                className="rounded bg-cyan-600 px-3 py-2 text-white disabled:opacity-50"
              >
                Use for next turn
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setChoosing(false)}
                className="rounded border border-zinc-700 px-3 py-2"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setChoosing(true)}
            className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
          >
            Use in this conversation…
          </button>
        ))}
    </div>
  );
}

export default function CodexEnvironments({
  threadId,
}: {
  threadId: string | null;
}) {
  const load = useCallback(() => getCodexEnvironments(threadId), [threadId]);
  const { data, loading, error, refresh } = useNativeSnapshot(
    "environments",
    threadId,
    load,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({
    environmentId: "",
    execServerUrl: "",
    authBearerToken: "",
    connectTimeoutMs: "",
    requiredSkills: "",
  });

  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage("");
    try {
      setMessage(await work());
      refresh();
    } catch (reason) {
      setMessage(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const register = (event: FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const timeout = form.connectTimeoutMs.trim();
      await addCodexEnvironment({
        environmentId: form.environmentId.trim(),
        execServerUrl: form.execServerUrl.trim(),
        authBearerToken: form.authBearerToken || null,
        connectTimeoutMs: timeout ? Number(timeout) : null,
        requiredSkills: parseSkillList(form.requiredSkills),
      });
      setForm((current) => ({ ...current, authBearerToken: "" }));
      return `Registered ${form.environmentId.trim()}.`;
    });
  };

  const select = (environmentId: string, cwd: string) =>
    void act(async () => {
      await setCodexThreadEnvironmentSelection(threadId!, {
        environmentId,
        cwd,
      });
      return `${environmentId} will be used from the next turn.`;
    });

  const thread = data?.thread ?? null;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Execution environments let Codex run tools on another machine through an
        exec server. Deck&apos;s local mode and remote access are unchanged;
        registrations last until the Codex app-server restarts.
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={loading || busy}
          onClick={refresh}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
      {loading && !data && <p role="status">Loading environments…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {data && !data.available && (
        <p className="break-words text-zinc-400">
          Execution environments are not available on this Codex server
          {data.unavailableReason ? ` (${data.unavailableReason})` : ""}.
        </p>
      )}
      {thread && (
        <section className="space-y-2 rounded-lg border border-zinc-700 p-3">
          <h3 className="font-semibold">This conversation</h3>
          <p className="break-words text-zinc-300">
            {thread.environments === null
              ? "Environment selection is reported once the conversation is loaded."
              : thread.environments.length
                ? `Current: ${thread.environments.map((env) => `${env.environmentId} (${env.cwd})`).join(", ")}`
                : "No environments are selected."}
          </p>
          {thread.pendingSelection && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="break-words text-amber-300">
                Next turn:{" "}
                {thread.pendingSelection
                  .map((env) => `${env.environmentId} (${env.cwd})`)
                  .join(", ")}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await setCodexThreadEnvironmentSelection(
                      thread.threadId,
                      null,
                    );
                    return "Pending environment selection cleared.";
                  })
                }
                className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          )}
          {thread.events.length > 0 && (
            <ul
              className="space-y-1 text-xs text-zinc-400"
              aria-label="Connection events"
            >
              {thread.events
                .slice(-10)
                .reverse()
                .map((event) => (
                  <li
                    key={`${event.at}:${event.environmentId}:${event.connected}`}
                  >
                    {new Date(event.at).toLocaleTimeString()} ·{" "}
                    <span className="break-all">{event.environmentId}</span>{" "}
                    {event.connected ? "connected" : "disconnected"}
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}
      {data?.environments.map((entry) => (
        <EnvironmentRow
          key={entry.environmentId}
          entry={entry}
          threadId={threadId}
          busy={busy}
          onSelect={select}
        />
      ))}
      {data?.available && (
        <form
          onSubmit={register}
          className="space-y-2 rounded-lg border border-zinc-700 p-3"
        >
          <h3 className="font-semibold">Register an environment</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              Environment ID
              <input
                className={inputClass}
                required
                value={form.environmentId}
                onChange={(event) =>
                  setForm({ ...form, environmentId: event.target.value })
                }
                placeholder="remote-a"
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Exec-server URL
              <input
                className={inputClass}
                required
                value={form.execServerUrl}
                onChange={(event) =>
                  setForm({ ...form, execServerUrl: event.target.value })
                }
                placeholder="wss://host:port"
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Bearer token (optional, sent once)
              <input
                className={inputClass}
                type="password"
                autoComplete="off"
                value={form.authBearerToken}
                onChange={(event) =>
                  setForm({ ...form, authBearerToken: event.target.value })
                }
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Connect timeout ms (optional)
              <input
                className={inputClass}
                inputMode="numeric"
                value={form.connectTimeoutMs}
                onChange={(event) =>
                  setForm({ ...form, connectTimeoutMs: event.target.value })
                }
              />
            </label>
          </div>
          <label className="block text-xs text-zinc-400">
            Required skills (optional, comma separated)
            <input
              className={inputClass}
              value={form.requiredSkills}
              onChange={(event) =>
                setForm({ ...form, requiredSkills: event.target.value })
              }
            />
          </label>
          <p className="text-xs text-zinc-500">
            Tokens require a secure (wss://) or loopback exec server and are
            never shown again.
          </p>
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-cyan-600 px-3 py-2 text-white disabled:opacity-50"
          >
            {busy ? "Registering…" : "Register environment"}
          </button>
        </form>
      )}
      {message && (
        <p role="status" className="break-words text-amber-300">
          {message}
        </p>
      )}
    </div>
  );
}
