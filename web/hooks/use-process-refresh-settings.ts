import { useCallback, useEffect, useState } from "react";
import {
  parseProcessRefreshSettings,
  PROCESS_REFRESH_STORAGE_KEY,
  type ProcessRefreshSettings,
} from "../process-refresh-settings";

const CHANGE_EVENT = "codex-deck:process-refresh-changed";

function readSettings(): ProcessRefreshSettings {
  if (typeof window === "undefined") return parseProcessRefreshSettings(null);
  try {
    return parseProcessRefreshSettings(
      localStorage.getItem(PROCESS_REFRESH_STORAGE_KEY),
    );
  } catch {
    return parseProcessRefreshSettings(null);
  }
}

export function useProcessRefreshSettings() {
  const [settings, setSettings] = useState(readSettings);

  useEffect(() => {
    const onChange = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key === null || event.key === PROCESS_REFRESH_STORAGE_KEY) {
          setSettings(readSettings());
        }
      } else {
        setSettings((event as CustomEvent<ProcessRefreshSettings>).detail);
      }
    };
    window.addEventListener("storage", onChange);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, []);

  const updateSettings = useCallback((next: ProcessRefreshSettings) => {
    const resolved = parseProcessRefreshSettings(JSON.stringify(next));
    try {
      localStorage.setItem(
        PROCESS_REFRESH_STORAGE_KEY,
        JSON.stringify(resolved),
      );
    } catch {
      // Keep preferences usable for this page when storage is unavailable.
    }
    setSettings(resolved);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: resolved }));
  }, []);

  return { settings, updateSettings };
}
