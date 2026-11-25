import type {
  CodexBackgroundTerminal,
  SessionTerminalRunSummary,
} from "@codex-deck/api";

export interface SessionProcess extends SessionTerminalRunSummary {
  terminal: CodexBackgroundTerminal | null;
}

/** Keep recently observed completions so their final output remains inspectable. */
export function mergeSessionProcesses(
  runs: SessionTerminalRunSummary[],
  terminals: CodexBackgroundTerminal[] | null,
  previous: SessionProcess[] = [],
): SessionProcess[] {
  const merged = new Map(
    previous.map((run) => [run.processId, { ...run, isRunning: false }]),
  );
  const activeIds =
    terminals === null
      ? null
      : new Set(terminals.map((terminal) => terminal.processId));
  for (const run of runs) {
    merged.set(run.processId, {
      ...run,
      isRunning: activeIds?.has(run.processId) ?? run.isRunning,
      terminal: merged.get(run.processId)?.terminal ?? null,
    });
  }
  for (const terminal of terminals ?? []) {
    const run = merged.get(terminal.processId);
    merged.set(terminal.processId, {
      processId: terminal.processId,
      callId: run?.callId ?? terminal.itemId,
      command: terminal.command || run?.command || "(unknown command)",
      isRunning: true,
      startedAt: run?.startedAt ?? null,
      endedAt: null,
      latestActivityAt: run?.latestActivityAt ?? null,
      terminal,
    });
  }
  return [...merged.values()]
    .sort(
      (a, b) =>
        Number(b.isRunning) - Number(a.isRunning) ||
        (b.latestActivityAt ?? "").localeCompare(a.latestActivityAt ?? ""),
    )
    .filter((run, index) => run.isRunning || index < 100);
}
