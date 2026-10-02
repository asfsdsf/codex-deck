import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadCodexDeckConfig } from "../config";
import {
  resolveConversationHoverSettings,
  type ConversationHoverSettings,
} from "../conversation-hover-settings";

export function registerConversationHoverSettingsRoutes(
  app: Hono,
  codexHome: string,
) {
  const listeners = new Set<(settings: ConversationHoverSettings) => void>();
  const disconnectors = new Set<() => void>();
  let current = resolveConversationHoverSettings(
    loadCodexDeckConfig(process.cwd(), codexHome).config.conversationHover,
  );
  let timer: ReturnType<typeof setInterval> | null = null;
  const refresh = () => {
    const next = resolveConversationHoverSettings(
      loadCodexDeckConfig(process.cwd(), codexHome).config.conversationHover,
    );
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      current = next;
      for (const listener of listeners) listener(current);
    }
    return current;
  };
  const subscribe = (
    listener: (settings: ConversationHoverSettings) => void,
  ) => {
    refresh();
    listeners.add(listener);
    listener(current);
    if (!timer) {
      // Pick up direct TOML edits as well as settings saved through the UI.
      timer = setInterval(refresh, 5_000);
      timer.unref();
    }
    return () => {
      listeners.delete(listener);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  };

  app.get("/api/codex-deck/hover-settings", (c) => c.json(refresh()));
  app.get("/api/codex-deck/hover-settings/stream", (c) =>
    streamSSE(c, async (stream) => {
      let release = () => {};
      let unsubscribe = () => {};
      const disconnected = new Promise<void>((resolve) => {
        release = resolve;
      });
      const write = (settings: ConversationHoverSettings) => {
        void stream
          .writeSSE({ event: "hoverSettings", data: JSON.stringify(settings) })
          .catch(release);
      };
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "heartbeat", data: "" }).catch(release);
      }, 15_000);
      heartbeat.unref();
      const cleanup = () => {
        clearInterval(heartbeat);
        disconnectors.delete(cleanup);
        unsubscribe();
        release();
      };
      stream.onAbort(cleanup);
      disconnectors.add(cleanup);
      unsubscribe = subscribe(write);
      try {
        await disconnected;
      } finally {
        cleanup();
      }
    }),
  );

  return {
    refresh,
    subscribe,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
      for (const disconnect of disconnectors) disconnect();
      listeners.clear();
    },
  };
}
