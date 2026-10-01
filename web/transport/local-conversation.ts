import type { ConversationMessageWindow, StreamResult } from "@codex-deck/api";
import { addCodexHomeToApiUrl } from "../codex-home-scope";
import { createReconnectingEventSource, requestLocalJson } from "./shared";
import type {
  ConversationStreamHandlers,
  ConversationStreamSubscriptionOptions,
} from "./types";

export function subscribeLocalConversation(
  sessionId: string,
  handlers: ConversationStreamHandlers,
  options: ConversationStreamSubscriptionOptions,
): () => void {
  const path = `/api/conversation/${encodeURIComponent(sessionId)}`;
  let offset =
    typeof options.initialOffset === "number" &&
    Number.isFinite(options.initialOffset) &&
    options.initialOffset > 0
      ? Math.floor(options.initialOffset)
      : 0;
  let historyStartSequence = options.initialHistoryStartSequence;
  let fileId = options.initialFileId;
  let cancelled = false;
  let epoch = 0;
  let controller = new AbortController();
  let unsubscribeStream: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const requestWindow = (beforeSequence?: number) =>
    requestLocalJson<ConversationMessageWindow>(
      `${path}/messages${beforeSequence === undefined ? "" : `?beforeSequence=${beforeSequence}`}`,
      { signal: controller.signal },
    );

  const clearPendingWork = () => {
    epoch += 1;
    controller.abort();
    controller = new AbortController();
    unsubscribeStream?.();
    unsubscribeStream = null;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const reset = () => {
    clearPendingWork();
    offset = 0;
    historyStartSequence = undefined;
    fileId = undefined;
    handlers.onReset?.();
    void bootstrap();
  };

  const scheduleBackfill = () => {
    if (cancelled || !historyStartSequence) {
      return;
    }
    // Let the recent messages paint before processing another history window.
    timer = setTimeout(() => {
      timer = null;
      void backfill();
    }, 16);
  };

  const backfill = async () => {
    const requestEpoch = epoch;
    const beforeSequence = historyStartSequence;
    if (!beforeSequence || cancelled) {
      return;
    }
    try {
      const window = await requestWindow(beforeSequence);
      if (cancelled || requestEpoch !== epoch) {
        return;
      }
      if (fileId && window.fileId && fileId !== window.fileId) {
        reset();
        return;
      }
      if (window.historyStartSequence >= beforeSequence) {
        throw new Error("Conversation history window did not advance");
      }
      historyStartSequence = window.historyStartSequence;
      handlers.onMessages(window.messages, {
        ...window,
        phase: "incremental",
        nextOffset: offset,
        insertion: "prepend",
        historyStartSequence,
        fileId,
      });
    } catch {
      if (cancelled || requestEpoch !== epoch) {
        return;
      }
      handlers.onError?.();
      // Retry failed history reads without affecting the live SSE connection.
      timer = setTimeout(() => {
        timer = null;
        void backfill();
      }, 1000);
      return;
    }
    scheduleBackfill();
  };

  const connectStream = () => {
    const streamEpoch = epoch;
    unsubscribeStream = createReconnectingEventSource({
      createUrl: () =>
        addCodexHomeToApiUrl(
          `${path}/stream?offset=${offset}&numbered=true${fileId ? `&fileId=${encodeURIComponent(fileId)}` : ""}`,
        ),
      configure: (eventSource) => {
        eventSource.addEventListener("messages", (event) => {
          if (cancelled || streamEpoch !== epoch) {
            return;
          }
          const payload = JSON.parse(event.data) as StreamResult;
          offset = Math.max(offset, payload.nextOffset);
          fileId = payload.fileId ?? fileId;
          handlers.onMessages(payload.messages, {
            ...payload,
            nextOffset: offset,
            phase: "incremental",
            insertion: "append",
            historyStartSequence,
            fileId,
          });
        });
        eventSource.addEventListener("reset", () => {
          if (!cancelled && streamEpoch === epoch) reset();
        });
        eventSource.addEventListener("heartbeat", () => {
          if (!cancelled && streamEpoch === epoch) handlers.onHeartbeat?.();
        });
      },
      onDisconnect: handlers.onError,
    });
  };

  const bootstrap = async () => {
    const requestEpoch = epoch;
    try {
      const window = await requestWindow();
      if (cancelled || requestEpoch !== epoch) {
        return;
      }
      offset = window.nextOffset;
      historyStartSequence = window.historyStartSequence;
      fileId = window.fileId;
      handlers.onMessages(window.messages, {
        ...window,
        phase: "bootstrap",
        insertion: "append",
      });
      if (cancelled || requestEpoch !== epoch) {
        return;
      }
      connectStream();
      scheduleBackfill();
    } catch {
      if (cancelled || requestEpoch !== epoch) {
        return;
      }
      handlers.onError?.();
      timer = setTimeout(() => {
        timer = null;
        void bootstrap();
      }, 1000);
    }
  };

  if (offset > 0) {
    connectStream();
    scheduleBackfill();
  } else {
    void bootstrap();
  }

  return () => {
    cancelled = true;
    clearPendingWork();
  };
}
