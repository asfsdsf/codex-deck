import type { CodexQueuedMessage } from "@codex-deck/api";
import type { PendingUserMessage } from "./pending-user-messages";

/**
 * Browser helpers for the app-server's shared message queue. Queued items
 * live on the server (so every tab and device sees the same queue) and the
 * app-server drains them itself when a turn completes; browsers never start
 * queued items automatically, which keeps several connected clients from
 * double-draining. The local browser queue remains the fallback for
 * app-servers without `thread/queue/*`.
 */
const SHARED_PENDING_PREFIX = "shared-queue:";

export function sharedQueuePendingId(itemId: string): string {
  return `${SHARED_PENDING_PREFIX}${itemId}`;
}

export function sharedQueueItemIdFromPendingId(
  pendingId: string,
): string | null {
  return pendingId.startsWith(SHARED_PENDING_PREFIX)
    ? pendingId.slice(SHARED_PENDING_PREFIX.length) || null
    : null;
}

export function sharedQueueItemToPendingUserMessage(
  item: CodexQueuedMessage,
): PendingUserMessage {
  return {
    pendingId: sharedQueuePendingId(item.id),
    text: item.text,
    images: item.images,
    status: "queued",
    sharedQueueId: item.id,
  };
}

/** Local pending messages first, then the server queue in its order. */
export function mergeSharedQueueIntoPending(
  local: readonly PendingUserMessage[],
  shared: readonly CodexQueuedMessage[],
): PendingUserMessage[] {
  if (shared.length === 0) {
    return local as PendingUserMessage[];
  }
  return [...local, ...shared.map(sharedQueueItemToPendingUserMessage)];
}

/**
 * Whether a new queue request may use the shared queue. Messages with
 * per-message send options (collaboration mode or cwd overrides) stay in the
 * local queue because the server queue only stores the input.
 */
export function shouldUseSharedQueue(input: {
  supported: boolean | null;
  hasSendOverrides: boolean;
}): boolean {
  return input.supported !== false && !input.hasSendOverrides;
}

export function sharedQueueCaption(input: { turnActive: boolean }): string {
  return input.turnActive
    ? "Queued — sends when the current turn finishes"
    : // Interrupted turns do not drain the server queue.
      "Queued — starts after the next completed turn, or use Send now";
}
