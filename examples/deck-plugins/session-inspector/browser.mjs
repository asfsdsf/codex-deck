/** Sandboxed Deck browser bridge. No direct parent DOM or network access. */
export function createDeckPlugin() {
  const pending = new Map();
  const listeners = new Set();
  let nextId = 0;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const receive = (event) => {
    if (event.source !== parent || event.data?.channel !== "codex-deck-plugin")
      return;
    const message = event.data;
    if (message.type === "initialize") resolveReady(message);
    if (message.type === "response") {
      const item = pending.get(message.requestId);
      if (item) {
        pending.delete(message.requestId);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error));
        else item.resolve(message.result);
      }
    } else for (const listener of listeners) listener(message);
  };
  window.addEventListener("message", receive);
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = `browser:${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Plugin request timed out."));
      }, 135_000);
      pending.set(requestId, { resolve, reject, timer });
      parent.postMessage(
        {
          channel: "codex-deck-plugin",
          type: "request",
          requestId,
          method,
          params,
        },
        "*",
      );
    });
  return {
    ready,
    request,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    worker: (method, params) => request("workerRequest", { method, params }),
    service: (service, method, params) =>
      request("callService", { service, method, params }),
    context: () => request("getContext"),
    state: {
      get: () => request("getState"),
      set: (state) => request("setState", { state }),
    },
    dispose() {
      window.removeEventListener("message", receive);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Plugin view closed."));
      }
      pending.clear();
      listeners.clear();
    },
  };
}
