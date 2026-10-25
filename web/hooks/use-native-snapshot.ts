import { useCallback, useEffect, useState } from "react";
import type { NativeScope } from "@codex-deck/api";
import { subscribeCodexRuntimeEvents } from "../codex-runtime-events";

export function useNativeSnapshot<T>(
  scope: NativeScope,
  threadId: string | null,
  load: () => Promise<T>,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(
    () =>
      subscribeCodexRuntimeEvents((event) => {
        if (
          !event ||
          (event.type === "native_state_changed" &&
            event.scope === scope &&
            (!event.threadId || event.threadId === threadId))
        )
          refresh();
      }),
    [scope, threadId, refresh],
  );
  useEffect(() => {
    const visible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [refresh]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void load()
      .then(
        (value) => {
          if (active) {
            setData(value);
            setError("");
          }
        },
        (reason) => {
          if (active)
            setError(reason instanceof Error ? reason.message : String(reason));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load, version]);
  return { data, error, loading, refresh, setData };
}
