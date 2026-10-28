import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ThreadReadStatesSnapshot,
  ThreadReadStateUpdateResult,
} from "@codex-deck/api";
import { subscribeCodexRuntimeEvents } from "../codex-runtime-events";
import {
  getThreadReadStates,
  updateThreadReadState,
} from "../codex-organization-api";
import {
  EMPTY_READ_STATES,
  applyReadStateResult,
  shouldAutoMarkRead,
} from "../thread-read-state";

const REFRESH_DEBOUNCE_MS = 400;

/**
 * Shared durable read receipts from the Codex app-server. Falls back to an
 * unavailable snapshot (Deck's browser-local status) when unsupported.
 * `refreshKey` should change when the session list changes so receipts
 * written by other Codex clients (TUI, desktop) are picked up.
 */
export function useThreadReadStates(
  enabled: boolean,
  scopeKey: string,
  refreshKey: unknown,
) {
  const [snapshot, setSnapshot] =
    useState<ThreadReadStatesSnapshot>(EMPTY_READ_STATES);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const attempted = useRef(new Map<string, string>());
  const suppressed = useRef(new Set<string>());
  const lastViewed = useRef<string | null>(null);

  useEffect(() => {
    setSnapshot(EMPTY_READ_STATES);
    attempted.current.clear();
    suppressed.current.clear();
  }, [scopeKey]);

  useEffect(
    () =>
      subscribeCodexRuntimeEvents((event) => {
        if (
          !event ||
          (event.type === "native_state_changed" && event.scope === "readState")
        )
          refresh();
      }),
    [refresh],
  );

  useEffect(() => {
    const visible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [refresh]);

  useEffect(() => {
    if (!enabled) return;
    const id = window.setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [enabled, refresh, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void getThreadReadStates().then(
      (next) => {
        if (active) setSnapshot(next);
      },
      () => {
        // Keep the last snapshot; a later event or visibility change retries.
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, scopeKey, version]);

  const apply = useCallback(
    (threadId: string, result: ThreadReadStateUpdateResult) => {
      setSnapshot((current) => applyReadStateResult(current, threadId, result));
    },
    [],
  );

  /** Call with the session the user is looking at while the page is visible. */
  const markViewed = useCallback(
    (threadId: string | null, visible: boolean) => {
      if (!visible) return;
      if (threadId !== lastViewed.current) {
        // Selecting another session is a fresh user action.
        suppressed.current.clear();
        lastViewed.current = threadId;
      }
      if (!threadId || !snapshotRef.current.available) return;
      const state = snapshotRef.current.states[threadId];
      if (
        !shouldAutoMarkRead(
          state,
          attempted.current.get(threadId),
          suppressed.current.has(threadId),
        )
      )
        return;
      attempted.current.set(threadId, state.revision);
      void updateThreadReadState(threadId, "read", state.revision).then(
        (result) => {
          // A conflict means another client acted on a state this page has not
          // shown; accept it and wait for a fresh selection before retrying.
          if (result.status === "conflict") suppressed.current.add(threadId);
          apply(threadId, result);
        },
        () => undefined,
      );
    },
    [apply],
  );

  /** Explicit read/unread toggle; resolves with the server outcome. */
  const setUnread = useCallback(
    async (
      threadId: string,
      unread: boolean,
    ): Promise<ThreadReadStateUpdateResult["status"]> => {
      const state = snapshotRef.current.states[threadId];
      if (!snapshotRef.current.available || !state) return "unavailable";
      if (unread) suppressed.current.add(threadId);
      else suppressed.current.delete(threadId);
      const result = await updateThreadReadState(
        threadId,
        unread ? "unread" : "read",
        state.revision,
      );
      apply(threadId, result);
      return result.status;
    },
    [apply],
  );

  return { snapshot, markViewed, setUnread, refresh };
}
