export interface CodexHookRun {
  threadId: string;
  turnId: string | null;
  run: {
    id: string;
    eventName: string;
    handlerType: string;
    executionMode: string;
    scope: string;
    sourcePath: string;
    source: string;
    displayOrder: number;
    status: string;
    statusMessage: string | null;
    startedAt: number;
    completedAt: number | null;
    durationMs: number | null;
    entries: { kind: string; text: string }[];
  };
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
export function parseHookRun(value: unknown): CodexHookRun | null {
  const event = record(value),
    run = record(event.run);
  if (
    typeof event.threadId !== "string" ||
    !event.threadId.trim() ||
    typeof run.id !== "string" ||
    !run.id ||
    typeof run.status !== "string"
  )
    return null;
  const string = (key: string) =>
    typeof run[key] === "string" ? (run[key] as string) : "";
  const number = (key: string) =>
    typeof run[key] === "number" && Number.isFinite(run[key])
      ? (run[key] as number)
      : null;
  return {
    threadId: event.threadId,
    turnId: typeof event.turnId === "string" ? event.turnId : null,
    run: {
      id: run.id,
      eventName: string("eventName"),
      handlerType: string("handlerType"),
      executionMode: string("executionMode"),
      scope: string("scope"),
      sourcePath: string("sourcePath"),
      source: string("source"),
      displayOrder: number("displayOrder") ?? 0,
      status: run.status,
      statusMessage:
        typeof run.statusMessage === "string" ? run.statusMessage : null,
      startedAt: number("startedAt") ?? 0,
      completedAt: number("completedAt"),
      durationMs: number("durationMs"),
      entries: Array.isArray(run.entries)
        ? run.entries.flatMap((value) => {
            const entry = record(value);
            return typeof entry.kind === "string" &&
              typeof entry.text === "string"
              ? [{ kind: entry.kind, text: entry.text }]
              : [];
          })
        : [],
    },
  };
}

// Retain a bounded, per-thread snapshot for all browsers, independently of subscribers.
export class HookRunStore {
  private threads = new Map<string, Map<string, CodexHookRun>>();
  record(event: CodexHookRun): void {
    const runs = this.threads.get(event.threadId) ?? new Map();
    const old = runs.get(event.run.id);
    if (old && old.run.status !== "running" && event.run.status === "running")
      return;
    runs.set(event.run.id, event);
    while (runs.size > 100) runs.delete(runs.keys().next().value!);
    this.threads.delete(event.threadId);
    this.threads.set(event.threadId, runs);
    while (this.threads.size > 128)
      this.threads.delete(this.threads.keys().next().value!);
  }
  list(threadId: string): CodexHookRun[] {
    return [...(this.threads.get(threadId)?.values() ?? [])].sort(
      (a, b) =>
        b.run.startedAt - a.run.startedAt ||
        a.run.displayOrder - b.run.displayOrder,
    );
  }
  clear(): void {
    this.threads.clear();
  }
}
