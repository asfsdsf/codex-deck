import type { DeckPluginWorkers } from "../deck-plugin-workers";
import type { Context, Hono } from "hono";
import { DeckPluginError, DeckPluginStore } from "../deck-plugin-store";
import {
  DECK_PLUGIN_STATE_MAX_BYTES,
  DeckPluginManifestError,
} from "../deck-plugin-manifest";

const base = "/api/deck/plugins";

export async function serveDeckPluginFile(
  c: Context,
  store: DeckPluginStore,
  id: string,
  filePath: string,
  publicFilesBase?: string,
) {
  try {
    const { bytes, mimeType } = await store.readPackageFile(id, filePath);
    const url = new URL(c.req.url);
    let filesBase = publicFilesBase;
    if (!filesBase) {
      const internalBase = c.req.header("x-codex-deck-plugin-file-base");
      if (internalBase) {
        const parsedBase = new URL(internalBase);
        let requestOrigin = url.origin;
        const referer = c.req.header("referer");
        if (referer) requestOrigin = new URL(referer).origin;
        const segments = parsedBase.pathname.split("/");
        if (
          parsedBase.origin !== requestOrigin ||
          parsedBase.search ||
          parsedBase.hash ||
          segments.length !== 6 ||
          segments[1] !== "api" ||
          segments[2] !== "deck-plugin-resource" ||
          !segments[3] ||
          segments[4] !== encodeURIComponent(id) ||
          segments[5] !== ""
        ) {
          throw new DeckPluginError("Invalid plugin asset route.", 400);
        }
        filesBase = parsedBase.href;
      }
    }
    filesBase ??= `${url.origin}${base}/${encodeURIComponent(id)}/files/`;
    c.header("Cache-Control", "no-store");
    c.header("Access-Control-Allow-Origin", "*");
    c.header("X-Content-Type-Options", "nosniff");
    c.header(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        ...(mimeType === "text/html" ? ["sandbox allow-scripts"] : []),
        `script-src 'unsafe-inline' ${filesBase}`,
        `style-src 'unsafe-inline' ${filesBase}`,
        `img-src data: ${filesBase}`,
        `font-src data: ${filesBase}`,
        `media-src data: ${filesBase}`,
        "connect-src 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'none'",
      ].join("; "),
    );
    c.header(
      "Content-Type",
      mimeType.startsWith("text/") ||
        mimeType.includes("javascript") ||
        mimeType === "application/json"
        ? `${mimeType}; charset=utf-8`
        : mimeType,
    );
    return c.body(Uint8Array.from(bytes).buffer as ArrayBuffer);
  } catch (error) {
    if (error instanceof DeckPluginError) {
      return c.json({ error: error.message }, error.status);
    }
    console.error("Deck plugin file request failed:", error);
    return c.json({ error: "Could not read the plugin package file." }, 500);
  }
}

async function body(
  c: Context,
  maxBytes: number,
  sizeError: string,
): Promise<Record<string, unknown>> {
  if (
    c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    throw new DeckPluginError("Expected an application/json request.", 400);
  }
  let received = 0;
  const stream = c.req.raw.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) {
        received += chunk.byteLength;
        if (received > maxBytes) throw new DeckPluginError(sizeError, 413);
        output.enqueue(chunk);
      },
    }),
  );
  const text = await new Response(stream).text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DeckPluginError("Expected a JSON object.", 400);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new DeckPluginError("Expected a JSON object.", 400);
  }
  return data as Record<string, unknown>;
}

async function respond<T>(c: Context, read: () => Promise<T>) {
  c.header("Cache-Control", "no-store");
  try {
    return c.json(await read());
  } catch (error) {
    if (error instanceof DeckPluginError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof DeckPluginManifestError)
      return c.json({ error: error.message }, 400);
    console.error("Deck plugin request failed:", error);
    return c.json(
      { error: "Could not access the Deck plugins registry." },
      500,
    );
  }
}

export function registerDeckPluginRoutes(
  app: Hono,
  store: DeckPluginStore,
  workers?: DeckPluginWorkers,
) {
  app.get(base, (c) => respond(c, () => store.list()));
  if (workers) {
    app.get(`${base}/:id/worker/:requestId`, (c) =>
      respond(c, () =>
        workers.readRequest(c.req.param("id"), c.req.param("requestId")),
      ),
    );
    app.get(`${base}/contributions`, (c) =>
      respond(c, () => workers.snapshot()),
    );
    app.post(`${base}/:id/session`, (c) =>
      respond(c, async () => {
        const input = await body(c, 2048, "Session request too large.");
        if (
          typeof input.threadId !== "string" ||
          !input.threadId.trim() ||
          typeof input.enabled !== "boolean"
        )
          throw new DeckPluginError("threadId and enabled are required.", 400);
        return workers.setSessionEnabled(
          c.req.param("id"),
          input.threadId,
          input.enabled,
        );
      }),
    );
    app.get(`${base}/:id/secrets`, (c) =>
      respond(c, () => workers.secretStatus(c.req.param("id"))),
    );
    app.put(`${base}/:id/secrets`, (c) =>
      respond(c, async () => {
        const input = await body(c, 32 * 1024, "Secret request too large.");
        return workers.setSecrets(c.req.param("id"), input);
      }),
    );
    app.post(`${base}/:id/worker`, (c) =>
      respond(c, async () => {
        const input = await body(c, 64 * 1024, "Worker request too large.");
        if (typeof input.method !== "string" || input.method.length > 80)
          throw new DeckPluginError("method is required.", 400);
        return workers.beginRequest(
          c.req.param("id"),
          input.method,
          input.params ?? {},
        );
      }),
    );
  }

  app.get(`${base}/:id/runtime`, (c) =>
    respond(c, () => store.getRuntime(c.req.param("id"))),
  );
  app.get(`${base}/:id/source`, (c) =>
    respond(c, () => store.getSource(c.req.param("id"))),
  );
  app.post(`${base}/install`, (c) =>
    respond(c, async () => {
      const input = await body(
        c,
        12 * 1024 * 1024,
        "Plugin package is too large.",
      );
      if (
        input.replaceVersion !== undefined &&
        typeof input.replaceVersion !== "string"
      ) {
        throw new DeckPluginError("Invalid plugin installation request.", 400);
      }
      if (!Array.isArray(input.files)) {
        throw new DeckPluginError("Select a plugin package folder.", 400);
      }
      return store.installPackage(input.files, input.replaceVersion);
    }),
  );
  app.get(`${base}/:id/files/:file{.+}`, async (c) => {
    return serveDeckPluginFile(
      c,
      store,
      c.req.param("id"),
      c.req.param("file"),
    );
  });
  app.post(`${base}/:id/enabled`, (c) =>
    respond(c, async () => {
      const input = await body(c, 256, "Plugin state request is too large.");
      if (typeof input.enabled !== "boolean") {
        throw new DeckPluginError("enabled must be a boolean.", 400);
      }
      return store.setEnabled(c.req.param("id"), input.enabled);
    }),
  );
  app.put(`${base}/:id/state`, (c) =>
    respond(c, async () => {
      const input = await body(
        c,
        DECK_PLUGIN_STATE_MAX_BYTES + 256,
        "Plugin state can be at most 64 KiB.",
      );
      if (
        !input.state ||
        typeof input.state !== "object" ||
        Array.isArray(input.state)
      ) {
        throw new DeckPluginError("state must be a JSON object.", 400);
      }
      return store.setPluginState(c.req.param("id"), input.state);
    }),
  );
  app.delete(`${base}/:id`, (c) =>
    respond(c, () => store.uninstall(c.req.param("id"))),
  );
}
