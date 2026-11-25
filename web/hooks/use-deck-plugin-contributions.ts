import { useCallback, useEffect, useState } from "react";
import type { DeckPluginContributionsSnapshot } from "../../api/deck-plugin-manifest";
import { subscribeCodexRuntimeEvents } from "../codex-runtime-events";
import {
  getDeckPluginContributions,
  setDeckPluginSessionEnabled,
} from "../deck-plugins-api";

export function useDeckPluginContributions(homeId: string, enabled: boolean) {
  const [result, setResult] = useState<{
    homeId: string;
    snapshot: DeckPluginContributionsSnapshot;
    offset: number;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    let pending = false;
    let refreshAgain = false;
    setResult(null);
    setError("");
    if (!enabled) return;
    const refresh = async () => {
      if (pending) {
        refreshAgain = true;
        return;
      }
      pending = true;
      try {
        const snapshot = await getDeckPluginContributions(homeId);
        if (current)
          setResult({
            homeId,
            snapshot,
            offset: snapshot.serverTime - Date.now(),
          });
      } catch {
        /* A later reconnect supplies a fresh snapshot. */
      } finally {
        pending = false;
        if (current && refreshAgain) {
          refreshAgain = false;
          void refresh();
        }
      }
    };
    void refresh();
    const off = subscribeCodexRuntimeEvents((event) => {
      if (
        !event ||
        (event.type === "native_state_changed" &&
          event.scope === "deck-plugins")
      )
        void refresh();
    });
    return () => {
      current = false;
      off();
    };
  }, [homeId, enabled]);
  const toggle = useCallback(
    async (pluginId: string, threadId: string, value: boolean) => {
      setError("");
      try {
        await setDeckPluginSessionEnabled(pluginId, threadId, value, homeId);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
    [homeId],
  );
  return {
    snapshot: result?.homeId === homeId ? result.snapshot : null,
    serverOffset: result?.offset ?? 0,
    toggle,
    error,
  };
}
