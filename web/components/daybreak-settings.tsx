import { useCallback, useState } from "react";
import { getCodexDaybreak, setCodexDaybreak } from "../api";
import { useNativeSnapshot } from "../hooks/use-native-snapshot";

export default function DaybreakSettings({
  threadId,
  model,
}: {
  threadId: string;
  model: string | null;
}) {
  const load = useCallback(
    () => getCodexDaybreak(threadId, model),
    [threadId, model],
  );
  const { data, error, loading, refresh, setData } = useNativeSnapshot(
    "daybreak",
    threadId,
    load,
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const supported = data?.models
    .find((entry) => entry.id === data.model)
    ?.programs.some(
      (program) => program === "daybreakBlue" || program === "daybreakRed",
    );
  const save = async (enabled: boolean) => {
    setSaving(true);
    setMessage("");
    try {
      const state = await setCodexDaybreak(
        threadId,
        enabled,
        data?.model || model,
      );
      setData(state);
      setMessage(
        `Daybreak ${state.enabled ? "enabled" : "disabled"} for new turns in this conversation.`,
      );
      refresh();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-400">
        Broader access for authorized cybersecurity work, subject to upstream
        account and model eligibility.
      </p>
      {loading && <p role="status">Checking Daybreak eligibility…</p>}
      {error && (
        <p role="alert" className="break-words text-red-400">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="space-y-1 rounded-lg border border-zinc-700 bg-zinc-950/40 p-3">
            <p>
              Daybreak: <strong>{data.enabled ? "On" : "Off"}</strong>
            </p>
            <p className="break-all text-zinc-400">
              Current model: {data.model || "Not reported"}
            </p>
          </div>
          {data.reason && (
            <p className="break-words text-amber-300">{data.reason}</p>
          )}
          {!supported && data.eligible && (
            <p className="text-amber-300">
              The selected model does not advertise Daybreak support. Choose a
              compatible model with /model before enabling it.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              disabled={
                saving ||
                loading ||
                (!data.enabled && (!data.eligible || !supported))
              }
              onClick={() => void save(!data.enabled)}
              className="rounded bg-cyan-600 px-3 py-2 text-white disabled:opacity-50"
            >
              {saving
                ? "Saving…"
                : data.enabled
                  ? "Turn Daybreak off"
                  : "Turn Daybreak on"}
            </button>
            <button
              disabled={saving || loading}
              onClick={refresh}
              className="rounded border border-zinc-700 px-3 py-2 disabled:opacity-50"
            >
              Refresh eligibility
            </button>
          </div>
          <details>
            <summary className="cursor-pointer">Model capabilities</summary>
            <ul className="mt-2 space-y-1 text-xs text-zinc-400">
              {data.models.map((entry) => (
                <li key={entry.id} className="break-words">
                  {entry.name}: {entry.programs.join(", ") || "Not reported"}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {message && (
        <p role="status" className="break-words">
          {message}
        </p>
      )}
    </div>
  );
}
