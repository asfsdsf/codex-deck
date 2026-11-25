import { useEffect, useRef, useState } from "react";
import type { SessionTerminalRunOutputResponse } from "@codex-deck/api";
import {
  getCodexBackgroundTerminals,
  getSessionTerminalRunOutput,
  getSessionTerminalRuns,
} from "../api";
import { subscribeCodexRuntimeEvents } from "../codex-runtime-events";
import { mergeSessionProcesses, type SessionProcess } from "../processes";
import { createWakeablePollingSubscription } from "../transport/shared";
import { usePageVisibility } from "./use-page-visibility";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function useProcesses(threadId: string, intervalMs: number) {
  const [processes, setProcesses] = useState<SessionProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [output, setOutput] = useState<SessionTerminalRunOutputResponse | null>(
    null,
  );
  const [outputError, setOutputError] = useState<string | null>(null);
  const listWake = useRef<() => void>(() => {});
  const outputWake = useRef<() => void>(() => {});
  const visible = usePageVisibility();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const subscription = createWakeablePollingSubscription(async () => {
      const [runs, terminals] = await Promise.allSettled([
        getSessionTerminalRuns(threadId),
        getCodexBackgroundTerminals(threadId),
      ]);
      if (cancelled) return;
      const errors: string[] = [];
      if (runs.status === "rejected")
        errors.push(`Saved processes unavailable: ${message(runs.reason)}`);
      else if (runs.value.unavailableReason)
        errors.push(runs.value.unavailableReason);
      if (terminals.status === "rejected")
        errors.push(`Live processes unavailable: ${message(terminals.reason)}`);
      if (runs.status === "fulfilled" || terminals.status === "fulfilled") {
        setProcesses((previous) =>
          mergeSessionProcesses(
            runs.status === "fulfilled" ? runs.value.runs : [],
            terminals.status === "fulfilled" ? terminals.value.terminals : null,
            previous,
          ),
        );
      }
      setError(errors.length ? errors.join(" · ") : null);
      setLoading(false);
    }, intervalMs);
    listWake.current = subscription.wake;
    const unsubscribe = subscribeCodexRuntimeEvents((event) => {
      if (
        !event ||
        (event.threadId === threadId &&
          event.type === "background_terminals_changed")
      ) {
        subscription.wake();
        outputWake.current();
      }
    });
    return () => {
      cancelled = true;
      listWake.current = () => {};
      subscription.unsubscribe();
      unsubscribe();
    };
  }, [threadId, intervalMs, visible]);

  useEffect(() => {
    setOutputError(null);
    if (!selectedId || !visible) return;
    let cancelled = false;
    const subscription = createWakeablePollingSubscription(async () => {
      try {
        const response = await getSessionTerminalRunOutput(
          threadId,
          selectedId,
        );
        if (cancelled) return;
        setOutput(response);
        setOutputError(response.unavailableReason);
        setProcesses((current) =>
          current.map((run) =>
            run.processId === selectedId
              ? { ...run, isRunning: response.isRunning }
              : run,
          ),
        );
      } catch (error) {
        if (!cancelled) setOutputError(message(error));
      }
    }, intervalMs);
    outputWake.current = subscription.wake;
    return () => {
      cancelled = true;
      outputWake.current = () => {};
      subscription.unsubscribe();
    };
  }, [threadId, selectedId, intervalMs, visible]);

  return {
    processes,
    loading,
    error,
    selectedId,
    setSelectedId,
    output: output?.processId === selectedId ? output : null,
    outputError,
    refresh: () => {
      listWake.current();
      outputWake.current();
    },
  };
}
