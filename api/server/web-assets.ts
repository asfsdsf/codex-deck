import { serveStatic } from "@hono/node-server/serve-static";
import { statSync } from "node:fs";
import { basename } from "node:path";
import type { Hono } from "hono";

export function registerWebAssets(app: Hono, root: string): void {
  const servedPaths = new WeakMap<Request, string>();
  // Registered after API routes: validators and compression apply only to UI
  // files, never the live event streams or private API responses.
  app.use("/*", async (c, next) => {
    await next();
    const path = servedPaths.get(c.req.raw);
    if (!path) return;

    const filename = basename(path).replace(/\.(?:gz|br)$/, "");
    const hashedAsset =
      c.req.path.startsWith("/assets/") && /-[\w-]{8,}\.[\w]+$/.test(filename);
    c.header(
      "Cache-Control",
      hashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
    );
    // The identity response must also vary, so a shared cache cannot serve
    // it to a browser that requested a compressed representation.
    c.header("Vary", "Accept-Encoding");
    const stats = statSync(path);
    c.header(
      "ETag",
      `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`,
    );
    if (c.res.status !== 200 || !["GET", "HEAD"].includes(c.req.method)) return;

    const etag = c.res.headers.get("ETag");
    const ifNoneMatch = c.req.header("If-None-Match");
    if (
      etag &&
      ifNoneMatch?.split(",").some((value) => {
        const tag = value.trim();
        return (
          tag === "*" || tag.replace(/^W\//, "") === etag.replace(/^W\//, "")
        );
      })
    ) {
      await c.res.body?.cancel();
      c.res = new Response(null, { status: 304, headers: c.res.headers });
      c.header("Content-Length", undefined);
      c.header("Content-Type", undefined);
      c.header("Content-Encoding", undefined);
    }
  });

  app.use(
    "/*",
    serveStatic({
      root,
      precompressed: true,
      onFound: (path, c) => {
        servedPaths.set(c.req.raw, path);
      },
    }),
  );

  // A stale asset URL after a rebuild must not receive the SPA's HTML fallback.
  app.get("/assets/*", (c) => c.notFound());
}
