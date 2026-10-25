import type { CodexAppServerEvent } from "@codex-deck/api";
// Reuse the page's existing local/remote subscription; null requests a fresh snapshot.
const listeners = new Set<(event: CodexAppServerEvent | null) => void>();
export function publishCodexRuntimeEvent(event: CodexAppServerEvent | null) {
  for (const listener of listeners) listener(event);
}
export function subscribeCodexRuntimeEvents(
  listener: (event: CodexAppServerEvent | null) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
