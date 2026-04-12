import { useEffect, useRef, useCallback } from "react";

interface EventHandler {
  eventName: string;
  onMessage: (event: MessageEvent) => void;
}

interface UseEventSourceOptions {
  events: EventHandler[];
  onError?: () => void;
  maxRetries?: number;
  baseDelay?: number;
  enabled?: boolean;
  pauseWhenHidden?: boolean;
}

export function useEventSource(url: string, options: UseEventSourceOptions) {
  const {
    events,
    onError,
    maxRetries = 10,
    baseDelay = 1000,
    enabled = true,
    pauseWhenHidden = true,
  } = options;

  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventAtRef = useRef(0);
  const retryCountRef = useRef(0);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const pauseWhenHiddenRef = useRef(pauseWhenHidden);
  pauseWhenHiddenRef.current = pauseWhenHidden;

  const closeCurrent = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const shouldPauseForVisibility = useCallback(() => {
    if (!pauseWhenHiddenRef.current || typeof document === "undefined") {
      return false;
    }

    return document.visibilityState !== "visible";
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled) {
      return;
    }

    if (shouldPauseForVisibility()) {
      closeCurrent();
      return;
    }

    closeCurrent();
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;
    lastEventAtRef.current = Date.now();

    eventSource.onopen = () => {
      retryCountRef.current = 0;
      lastEventAtRef.current = Date.now();
    };

    for (const handler of eventsRef.current) {
      eventSource.addEventListener(handler.eventName, (event) => {
        retryCountRef.current = 0;
        lastEventAtRef.current = Date.now();
        handler.onMessage(event);
      });
    }

    eventSource.onerror = () => {
      closeCurrent();

      if (!mountedRef.current) {
        return;
      }

      if (shouldPauseForVisibility()) {
        return;
      }

      if (retryCountRef.current < maxRetries) {
        const delay = Math.min(
          baseDelay * Math.pow(2, retryCountRef.current),
          30000,
        );
        retryCountRef.current++;

        retryTimeoutRef.current = setTimeout(() => {
          connect();
        }, delay);
      } else {
        onError?.();
      }
    };
  }, [
    url,
    onError,
    maxRetries,
    baseDelay,
    enabled,
    closeCurrent,
    shouldPauseForVisibility,
  ]);

  useEffect(() => {
    mountedRef.current = true;

    if (enabled) {
      connect();
    } else {
      retryCountRef.current = 0;
      closeCurrent();
    }

    const handleVisibilityChange = () => {
      if (!mountedRef.current || !enabled) {
        return;
      }

      if (shouldPauseForVisibility()) {
        closeCurrent();
        return;
      }

      retryCountRef.current = 0;
      connect();
    };

    const handleResumeLikeEvent = () => {
      if (!mountedRef.current || !enabled) {
        return;
      }
      if (shouldPauseForVisibility()) {
        return;
      }
      retryCountRef.current = 0;
      connect();
    };

    const healthCheckInterval = setInterval(() => {
      if (!mountedRef.current || !enabled) {
        return;
      }
      if (shouldPauseForVisibility()) {
        return;
      }

      const current = eventSourceRef.current;
      const now = Date.now();
      const staleThresholdMs = 45000;

      if (!current || now - lastEventAtRef.current > staleThresholdMs) {
        retryCountRef.current = 0;
        connect();
      }
    }, 15000);

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleResumeLikeEvent);
      window.addEventListener("pageshow", handleResumeLikeEvent);
      window.addEventListener("online", handleResumeLikeEvent);
    }

    return () => {
      mountedRef.current = false;
      clearInterval(healthCheckInterval);
      if (typeof document !== "undefined") {
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        );
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleResumeLikeEvent);
        window.removeEventListener("pageshow", handleResumeLikeEvent);
        window.removeEventListener("online", handleResumeLikeEvent);
      }
      closeCurrent();
    };
  }, [connect, enabled, closeCurrent, shouldPauseForVisibility]);
}
