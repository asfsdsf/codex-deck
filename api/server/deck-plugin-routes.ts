import type { Context, Hono } from "hono";
import { DeckPluginError, DeckPluginStore } from "../deck-plugin-store";
import {
  DECK_PLUGIN_MANIFEST_MAX_BYTES,
  DeckPluginManifestError,
} from "../deck-plugin-manifest";

const base = "/api/deck/plugins";

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

export function registerDeckPluginRoutes(app: Hono, store: DeckPluginStore) {
  app.get(base, (c) => respond(c, () => store.list()));
  app.post(`${base}/install`, (c) =>
    respond(c, async () => {
      const input = await body(
        c,
        DECK_PLUGIN_MANIFEST_MAX_BYTES + 256,
        "Plugin manifests can be at most 128 KiB.",
      );
      if (
        input.replaceVersion !== undefined &&
        typeof input.replaceVersion !== "string"
      ) {
        throw new DeckPluginError("Invalid plugin installation request.", 400);
      }
      return store.installFile(input.manifest, input.replaceVersion);
    }),
  );
  app.post(`${base}/:id/enabled`, (c) =>
    respond(c, async () => {
      const input = await body(c, 256, "Plugin state request is too large.");
      if (typeof input.enabled !== "boolean") {
        throw new DeckPluginError("enabled must be a boolean.", 400);
      }
      return store.setEnabled(c.req.param("id"), input.enabled);
    }),
  );
  app.delete(`${base}/:id`, (c) =>
    respond(c, () => store.uninstall(c.req.param("id"))),
  );
}
