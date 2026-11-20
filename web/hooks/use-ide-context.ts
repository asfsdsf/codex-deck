import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodexIdeContextSummary,
  SendCodexMessageIdeContextResult,
} from "@codex-deck/api";
import { getCodexIdeContextStatus } from "../api";
import {
  describeIdeContextStatus,
  IDE_COMMAND_USAGE,
  IDE_CONTEXT_OFF_MESSAGE,
  IDE_CONTEXT_SKIPPED_MESSAGE,
  parseIdeCommandArgs,
} from "../ide-context";

const NOTICE_MS = 5000;

/**
 * Per-page `/ide` state, mirroring the TUI's per-session `IdeContextState`:
 * off by default, enabled only when the IDE answers, and warns once per
 * enable when context has to be skipped for a message.
 */
export function useIdeContext(input: {
  threadId: string | null;
  cwd: string | null | undefined;
  showNotice: (message: string, durationMs?: number) => void;
  showError: (message: string) => void;
}) {
  const { threadId, cwd, showNotice, showError } = input;
  const [enabled, setEnabled] = useState(false);
  const [summary, setSummary] = useState<CodexIdeContextSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const enabledRef = useRef(false);
  const warnedRef = useRef(false);
  const requestSeqRef = useRef(0);
  const targetRef = useRef({ threadId, cwd: cwd ?? null });

  useEffect(() => {
    targetRef.current = { threadId, cwd: cwd ?? null };
  }, [threadId, cwd]);

  const applyEnabled = useCallback((next: boolean) => {
    enabledRef.current = next;
    warnedRef.current = false;
    setEnabled(next);
    if (!next) setSummary(null);
  }, []);

  /** Enable (or re-check) by asking the backend for fresh IDE context. */
  const check = useCallback(
    async (options: { announce: boolean }) => {
      const seq = ++requestSeqRef.current;
      setChecking(true);
      try {
        const status = await getCodexIdeContextStatus(targetRef.current);
        if (seq !== requestSeqRef.current) return;
        const result = describeIdeContextStatus(status);
        applyEnabled(result.enabled);
        if (status.available) setSummary(status.summary);
        if (options.announce || !result.enabled) {
          showNotice(result.message, NOTICE_MS);
        }
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        applyEnabled(false);
        showError(error instanceof Error ? error.message : String(error));
      } finally {
        if (seq === requestSeqRef.current) setChecking(false);
      }
    },
    [applyEnabled, showError, showNotice],
  );

  const disable = useCallback(() => {
    requestSeqRef.current += 1;
    setChecking(false);
    applyEnabled(false);
    showNotice(IDE_CONTEXT_OFF_MESSAGE);
  }, [applyEnabled, showNotice]);

  const runCommand = useCallback(
    async (args: string): Promise<boolean> => {
      const action = parseIdeCommandArgs(args);
      if (action === null) {
        showError(IDE_COMMAND_USAGE);
        return false;
      }
      if (action === "off" || (action === "toggle" && enabledRef.current)) {
        disable();
        return true;
      }
      if (action === "status" && !enabledRef.current) {
        showNotice(IDE_CONTEXT_OFF_MESSAGE);
        return true;
      }
      await check({ announce: true });
      return true;
    },
    [check, disable, showError, showNotice],
  );

  /** Apply the send response: refresh the summary or warn once on skip. */
  const handleSendResult = useCallback(
    (result: SendCodexMessageIdeContextResult | undefined) => {
      if (!result || !enabledRef.current) return;
      if (result.summary) {
        warnedRef.current = false;
        setSummary(result.summary);
        return;
      }
      if (result.skippedHint && !warnedRef.current) {
        warnedRef.current = true;
        showNotice(
          `${IDE_CONTEXT_SKIPPED_MESSAGE} ${result.skippedHint}`,
          NOTICE_MS,
        );
      }
    },
    [showNotice],
  );

  return {
    enabled,
    enabledRef,
    summary,
    checking,
    runCommand,
    refresh: () => check({ announce: false }),
    disable,
    handleSendResult,
  };
}
