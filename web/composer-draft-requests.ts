// Hands text to a session's composer (for example a rewound prompt) even if
// the composer mounts after the request, such as after a session switch.
const pending = new Map<string, string>();
const listeners = new Set<(sessionId: string) => void>();

export function requestComposerDraft(sessionId: string, text: string): void {
  pending.set(sessionId, text);
  for (const listener of listeners) listener(sessionId);
}

/** Returns and clears the pending draft for this session, if any. */
export function takeComposerDraft(sessionId: string): string | null {
  const text = pending.get(sessionId);
  if (text === undefined) return null;
  pending.delete(sessionId);
  return text;
}

export function subscribeComposerDraftRequests(
  listener: (sessionId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
