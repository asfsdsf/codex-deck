import { useCallback, useState } from "react";
import {
  getCodexExperimentalFeatures,
  setCodexExperimentalFeatures,
} from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

export default function ExperimentalFeatures({
  threadId,
}: {
  threadId: string | null;
}) {
  const load = useCallback(
    () => getCodexExperimentalFeatures(threadId),
    [threadId],
  );
  const { data, loading, error, refresh, setData } = useNativeSnapshot(
    "experimental",
    threadId,
    load,
  );
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const save = async () => {
    setSaving(true);
    setMessage("");
    try {
      const result = await setCodexExperimentalFeatures(threadId, draft);
      setData({ features: result.features });
      setDraft({});
      setMessage(result.warning || "Feature settings saved.");
      refresh();
    } catch (reason) {
      setMessage(
        `Could not confirm feature settings: ${reason instanceof Error ? reason.message : String(reason)}. Refresh before retrying.`,
      );
    } finally {
      setSaving(false);
    }
  };
  const visible = (data?.features ?? []).filter(
    (feature) => all || feature.stage === "beta",
  );
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Configure features advertised by the connected Codex server. Running
        tasks keep their existing settings.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => setAll(event.target.checked)}
          />
          Show all feature stages
        </label>
        <button
          disabled={loading || saving}
          onClick={refresh}
          className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
        >
          Refresh features
        </button>
      </div>
      {loading && <p role="status">Loading features…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {!loading && !error && !visible.length && (
        <p>No {all ? "features" : "beta features"} advertised.</p>
      )}
      {visible.map((feature) => (
        <label
          key={feature.name}
          className="flex items-start gap-3 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3"
        >
          <input
            className="mt-1"
            type="checkbox"
            aria-label={feature.displayName || feature.name}
            disabled={
              saving || ["removed", "deprecated"].includes(feature.stage)
            }
            checked={draft[feature.name] ?? feature.enabled}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                [feature.name]: event.target.checked,
              }))
            }
          />
          <span className="min-w-0">
            <span className="block break-words font-semibold">
              {feature.displayName || feature.name}
            </span>
            <span className="block break-all text-xs text-zinc-400">
              {feature.name} · {feature.stage} · Default:{" "}
              {feature.defaultEnabled ? "on" : "off"}
            </span>
            {feature.description && (
              <span className="mt-1 block whitespace-pre-wrap break-words text-zinc-300">
                {feature.description}
              </span>
            )}
            {feature.announcement && (
              <span className="mt-1 block whitespace-pre-wrap break-words text-xs text-zinc-400">
                {feature.announcement}
              </span>
            )}
          </span>
        </label>
      ))}
      {message && (
        <p role="status" className="break-words text-amber-300">
          {message}
        </p>
      )}
      <button
        disabled={saving || loading || !Object.keys(draft).length}
        onClick={() => void save()}
        className="rounded bg-cyan-600 px-3 py-2 text-white disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save feature settings"}
      </button>
    </div>
  );
}
