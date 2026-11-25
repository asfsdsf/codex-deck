import { useEffect, useState } from "react";
import { useProcessRefreshSettings } from "../hooks/use-process-refresh-settings";
import {
  DEFAULT_PROCESS_REFRESH_SETTINGS,
  isProcessRefreshInterval,
  MAX_PROCESS_REFRESH_MS,
  MIN_PROCESS_REFRESH_MS,
  type ProcessConnectionMode,
} from "../process-refresh-settings";

export default function ProcessRefreshSettings({
  inputClassName,
}: {
  inputClassName: string;
}) {
  const { settings, updateSettings } = useProcessRefreshSettings();
  const [draft, setDraft] = useState({
    local: String(settings.local / 1000),
    remote: String(settings.remote / 1000),
  });
  useEffect(() => {
    setDraft({
      local: String(settings.local / 1000),
      remote: String(settings.remote / 1000),
    });
  }, [settings.local, settings.remote]);

  function apply(mode: ProcessConnectionMode) {
    const milliseconds = draft[mode].trim()
      ? Math.round(Number(draft[mode]) * 1000)
      : DEFAULT_PROCESS_REFRESH_SETTINGS[mode];
    if (isProcessRefreshInterval(milliseconds)) {
      updateSettings({ ...settings, [mode]: milliseconds });
      setDraft((current) => ({
        ...current,
        [mode]: String(milliseconds / 1000),
      }));
    } else {
      setDraft((current) => ({
        ...current,
        [mode]: String(settings[mode] / 1000),
      }));
    }
  }

  return (
    <div className="mt-7">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 pb-3">
        <h3 className="text-sm font-semibold text-zinc-100">Process refresh</h3>
        <span className="text-xs text-zinc-500">Applies immediately</span>
      </div>
      <p className="mt-3 text-xs leading-5 text-zinc-500">
        Refresh background processes and output every 0.1–60 seconds. Saved
        automatically in this browser. Hidden pages pause refreshing.
      </p>
      <div className="grid gap-5 py-5 sm:grid-cols-2">
        {(["local", "remote"] as const).map((mode) => (
          <label key={mode} className="grid gap-2 text-sm text-zinc-200">
            {mode === "local"
              ? "Local refresh (seconds)"
              : "Remote refresh (seconds)"}
            <input
              type="number"
              min={MIN_PROCESS_REFRESH_MS / 1000}
              max={MAX_PROCESS_REFRESH_MS / 1000}
              step="any"
              inputMode="decimal"
              value={draft[mode]}
              placeholder={String(
                DEFAULT_PROCESS_REFRESH_SETTINGS[mode] / 1000,
              )}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  [mode]: event.target.value,
                }))
              }
              onBlur={() => apply(mode)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  apply(mode);
                }
              }}
              className={inputClassName}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
