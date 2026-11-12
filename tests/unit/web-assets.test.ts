import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gzipSync,
  gunzipSync,
} from "node:zlib";
import { Hono } from "hono";
import { registerWebAssets } from "../../api/server/web-assets";

test("web assets negotiate compression, cache hashed files, and revalidate HTML", async () => {
  const root = await mkdtemp(join(tmpdir(), "web-assets-"));
  const asset = "console.log('compressed asset');\n".repeat(100);
  const app = new Hono();
  app.get("/api/events", (c) =>
    c.body("event: heartbeat\ndata: {}\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }),
  );
  registerWebAssets(app, root);
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<html>first build</html>");
    const assetPath = join(root, "assets", "index-AbCd1234.js");
    await writeFile(assetPath, asset);
    await writeFile(assetPath + ".gz", gzipSync(asset));
    await writeFile(assetPath + ".br", brotliCompressSync(asset));

    const identity = await app.request("/assets/index-AbCd1234.js");
    assert.equal(
      identity.headers.get("Cache-Control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal(identity.headers.get("Vary"), "Accept-Encoding");
    assert.equal(await identity.text(), asset);
    const identityTag = identity.headers.get("ETag")!;
    assert.ok(identityTag);

    for (const encoding of ["gzip", "br"]) {
      const response = await app.request("/assets/index-AbCd1234.js", {
        headers: { "Accept-Encoding": encoding },
      });
      assert.equal(response.headers.get("Content-Encoding"), encoding);
      assert.match(response.headers.get("Content-Type")!, /javascript/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length < Buffer.byteLength(asset));
      const decode = encoding === "gzip" ? gunzipSync : brotliDecompressSync;
      assert.equal(decode(bytes).toString(), asset);
    }

    const cached = await app.request("/assets/index-AbCd1234.js", {
      headers: { "If-None-Match": `"other", ${identityTag}` },
    });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), "");
    assert.equal(cached.headers.get("Content-Length"), null);
    assert.match(cached.headers.get("Cache-Control")!, /immutable/);

    const head = await app.request("/assets/index-AbCd1234.js", {
      method: "HEAD",
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(head.headers.get("Content-Encoding"), "gzip");
    assert.equal(
      head.headers.get("Content-Length"),
      String(gzipSync(asset).length),
    );
    assert.equal(await head.text(), "");

    const html = await app.request("/");
    assert.equal(html.headers.get("Cache-Control"), "no-cache");
    const htmlTag = html.headers.get("ETag")!;
    assert.equal(
      (await app.request("/", { headers: { "If-None-Match": htmlTag } }))
        .status,
      304,
    );
    await writeFile(
      join(root, "index.html"),
      "<html>second, changed build</html>",
    );
    const rebuilt = await app.request("/", {
      headers: { "If-None-Match": htmlTag },
    });
    assert.equal(rebuilt.status, 200);
    assert.match(await rebuilt.text(), /changed build/);
    assert.notEqual(rebuilt.headers.get("ETag"), htmlTag);

    const missing = await app.request("/assets/index-old12345.js");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("Cache-Control"), null);
    const events = await app.request("/api/events", {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(events.headers.get("Content-Encoding"), null);
    assert.equal(events.headers.get("Cache-Control"), null);
    assert.match(await events.text(), /heartbeat/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
