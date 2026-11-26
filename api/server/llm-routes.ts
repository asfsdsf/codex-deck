import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { LlmConversations } from "../llm-conversations";
import { onLlmHistoryChange, onLlmProvidersChange } from "../watcher";

function changes(
  c: Context,
  subscribe: (notify: () => void) => () => void,
  heartbeatEvent: "change" | "heartbeat",
) {
  return streamSSE(c, async (stream) => {
    let release!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      release = resolve;
    });
    const emit = (event: string) => {
      void stream.writeSSE({ event, data: "{}" }).catch(release);
    };
    const unsubscribe = subscribe(() => emit("change"));
    stream.onAbort(release);
    emit("change");
    const timer = setInterval(() => emit(heartbeatEvent), 20_000);
    try {
      await disconnected;
    } finally {
      clearInterval(timer);
      unsubscribe();
    }
  });
}

export function registerLlmRoutes(app: Hono, codexHome: string) {
  const store = new LlmConversations(codexHome);
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    return c.json(
      { error: "Could not access provider or conversation storage." },
      500,
    );
  });
  routes.use("*", async (c, next) => {
    if (
      c.req.method === "POST" &&
      !c.req
        .header("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase()
        .match(/^application\/json$/)
    ) {
      return c.json({ error: "Expected application/json" }, 415);
    }
    await next();
  });
  routes.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object")
      return c.json({ error: "Invalid provider" }, 400);
    return c.json(await store.addProvider(body), 201);
  });
  routes.get("/stream", (c) => changes(c, onLlmProvidersChange, "heartbeat"));
  routes.get("/:provider", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await store.settings(c.req.param("provider")));
  });
  routes.post("/:provider", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object")
      return c.json({ error: "Invalid provider" }, 400);
    return c.json(await store.updateProvider(c.req.param("provider"), body));
  });
  routes.delete("/:provider", async (c) => {
    await store.removeProvider(
      c.req.param("provider"),
      c.req.query("revision"),
    );
    return c.json({ ok: true });
  });
  routes.get("/:provider/conversations", async (c) =>
    c.json(await store.list(c.req.param("provider"))),
  );
  routes.get("/:provider/conversations/:id", async (c) =>
    c.json(await store.read(c.req.param("provider"), c.req.param("id"))),
  );
  routes.post("/:provider/conversations/:id", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object")
      return c.json({ error: "Invalid turn" }, 400);
    await store.send(c.req.param("provider"), c.req.param("id"), body);
    return c.json({ accepted: true }, 202);
  });
  routes.get("/:provider/stream", (c) => {
    const providerId = c.req.param("provider");
    return changes(
      c,
      (notify) =>
        onLlmHistoryChange((id) => {
          if (id === providerId) notify();
        }),
      "change",
    );
  });
  app.route("/api/codex-homes/providers", routes);
  return store;
}
