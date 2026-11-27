import type { Session, ConversationMessage } from "@codex-deck/api";
import { addCodexHomeToApiUrl } from "../codex-home-scope";

interface ApiErrorPayload {
  error?: string;
}

interface ReconnectingEventSourceOptions {
  createUrl: () => string;
  configure: (eventSource: EventSource) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface WakeablePollingSubscription {
  unsubscribe: () => void;
  wake: () => void;
}

export async function requestLocalJson<T>(
  url: string,
  init?: RequestInit,
  homeId?: string,
): Promise<T> {
  const response = await fetch(addCodexHomeToApiUrl(url, homeId), init);
  const text = await response.text();
  let payload: (T | ApiErrorPayload) | null = null;
  // Track parse failures explicitly. Valid JSON objects may legitimately
  // carry a `text` field (for example plugin hook job results).
  let nonJsonText: string | null = null;

  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as T | ApiErrorPayload;
    } catch {
      nonJsonText = text;
    }
  }

  if (!response.ok) {
    const errorMessage =
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof (payload as ApiErrorPayload).error === "string"
        ? (payload as ApiErrorPayload).error
        : nonJsonText !== null
          ? `Request failed with status ${response.status} (${response.headers.get("content-type") || "unknown"}): ${nonJsonText.replace(/\s+/g, " ").trim().slice(0, 200)}`
          : `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  if (nonJsonText !== null) {
    throw new Error(
      `Endpoint returned a non-JSON response (${response.headers.get("content-type") || "unknown"}): ${nonJsonText
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200)}`,
    );
  }

  if (payload === null) {
    return {} as T;
  }

  return payload as T;
}

export function sessionsEqual(left: Session, right: Session): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createPollingSubscription(
  poll: () => Promise<void>,
  intervalMs: number,
): () => void {
  return createWakeablePollingSubscription(poll, intervalMs).unsubscribe;
}

export function createWakeablePollingSubscription(
  poll: () => Promise<void>,
  intervalMs: number,
): WakeablePollingSubscription {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let rerunRequested = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (cancelled) {
      return;
    }
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, intervalMs);
  };

  const run = async () => {
    if (cancelled) {
      return;
    }
    if (inFlight) {
      rerunRequested = true;
      return;
    }
    inFlight = true;
    try {
      await poll();
    } finally {
      inFlight = false;
      if (cancelled) {
        return;
      }
      if (rerunRequested) {
        rerunRequested = false;
        void run();
        return;
      }
      schedule();
    }
  };

  void run();

  return {
    unsubscribe: () => {
      cancelled = true;
      clearTimer();
    },
    wake: () => {
      if (cancelled) {
        return;
      }
      clearTimer();
      if (inFlight) {
        rerunRequested = true;
        return;
      }
      void run();
    },
  };
}

export function getConversationMessageKey(
  message: ConversationMessage,
): string {
  return message.uuid || `${message.timestamp}-${message.type}`;
}

export function createReconnectingEventSource(
  options: ReconnectingEventSourceOptions,
): () => void {
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;

  let cancelled = false;
  let retryCount = 0;
  let eventSource: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const closeEventSource = () => {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };

  const scheduleReconnect = () => {
    if (cancelled) {
      return;
    }
    const delay = Math.min(baseDelayMs * Math.pow(2, retryCount), maxDelayMs);
    retryCount += 1;
    timer = setTimeout(() => {
      connect();
    }, delay);
  };

  const connect = () => {
    if (cancelled) {
      return;
    }

    clearTimer();
    closeEventSource();

    const current = new EventSource(options.createUrl());
    eventSource = current;
    current.onopen = () => {
      retryCount = 0;
      options.onOpen?.();
    };
    options.configure(current);
    current.onerror = () => {
      if (cancelled) {
        return;
      }
      closeEventSource();
      options.onDisconnect?.();
      scheduleReconnect();
    };
  };

  connect();

  return () => {
    cancelled = true;
    clearTimer();
    closeEventSource();
  };
}
