/** Copy this module into a plugin package, or import it from codex-deck/plugin-sdk/worker.mjs. */
export function definePlugin(apply) {
  const pending = new Map();
  const handlers = new Map();
  const services = new Map();
  const listeners = new Set();
  const cleanup = [];
  const abort = new AbortController();
  let nextId = 0;
  let initialized = false;
  const send = (message) => {
    if (process.connected) process.send(message);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      abort.signal.throwIfAborted();
      const requestId = `sdk:${++nextId}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Host call ${method} timed out.`));
      }, 125_000);
      pending.set(requestId, { resolve, reject, timer });
      send({ type: "request", requestId, method, params });
    });
  const dispose = async () => {
    abort.abort(new Error("Plugin stopped."));
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(abort.signal.reason);
    }
    pending.clear();
    for (const fn of cleanup.splice(0).reverse())
      await Promise.resolve()
        .then(fn)
        .catch(() => {});
    listeners.clear();
  };
  process.on("disconnect", () => {
    void dispose().finally(() => process.exit(0));
  });
  process.on("message", async (message) => {
    if (message.type === "response") {
      const item = pending.get(message.requestId);
      if (!item) return;
      pending.delete(message.requestId);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error));
      else item.resolve(message.result);
      return;
    }
    if (message.type === "initialize" && !initialized) {
      initialized = true;
      try {
        await apply({
          plugin: message.plugin,
          signal: abort.signal,
          call,
          effect: (fn) => cleanup.push(fn),
          interval(fn, milliseconds) {
            const timer = setInterval(() => {
              Promise.resolve()
                .then(fn)
                .catch((error) => console.error(error));
            }, milliseconds);
            cleanup.push(() => clearInterval(timer));
          },
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          handle(method, handler) {
            if (handlers.has(method))
              throw new Error(`Duplicate request method ${method}.`);
            handlers.set(method, handler);
          },
          provide(name, handler) {
            if (services.has(name))
              throw new Error(`Duplicate service ${name}.`);
            services.set(name, handler);
          },
          services: {
            list: () => call("services.list"),
            call: (service, method, params = {}) =>
              call("services.call", { service, method, params }),
          },
          data: {
            get: () => call("data.get"),
            set: (data) => call("data.set", { data }),
          },
          secrets: {
            get: () => call("secrets.get"),
            set: (secrets) => call("secrets.set", { secrets }),
          },
          sessions: {
            get: (threadId) => call("sessions.get", { threadId }),
            list: () => call("sessions.list"),
            submit: (params) => call("sessions.submit", params),
            submission: (requestId) =>
              call("sessions.submission", { requestId }),
          },
          status: {
            set: (threadId, status) => call("status.set", { threadId, status }),
          },
          http: { request: (params) => call("http.request", params) },
          codex: {
            homes: () => call("codex.homes.list"),
            ensure: (params) => call("codex.sessions.ensure", params),
            get: (params) => call("codex.sessions.get", params),
            submit: (params) => call("codex.sessions.submit", params),
            interrupt: (params) => call("codex.sessions.interrupt", params),
          },
        });
        send({ type: "ready" });
      } catch (error) {
        console.error(error);
        await dispose();
        process.exit(1);
      }
      return;
    }
    if (message.type === "event") {
      for (const listener of listeners)
        void Promise.resolve()
          .then(() => listener(message.event))
          .catch((error) => console.error(error));
      return;
    }
    if (message.type !== "request") return;
    try {
      let result;
      if (message.method === "service.call") {
        const handler = services.get(message.params.service);
        if (!handler) throw new Error("Service has no handler.");
        result = await handler(message.params.method, message.params.params, {
          caller: message.params.caller,
          signal: abort.signal,
        });
      } else if (message.method === "host.shutdown") {
        result = await handlers.get(message.method)?.(message.params);
        await dispose();
      } else {
        const handler = handlers.get(message.method);
        if (!handler)
          throw new Error(`Unknown plugin method ${message.method}.`);
        result = await handler(message.params);
      }
      send({
        type: "response",
        requestId: message.requestId,
        result: result ?? null,
      });
    } catch (error) {
      send({
        type: "response",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
