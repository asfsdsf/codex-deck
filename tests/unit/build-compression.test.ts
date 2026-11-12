import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";
import { precompressAssets } from "../../web/build-compression";

test("precompressed assets match Vite's final dynamic-import code", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "compressed-vite-build-")),
  );
  try {
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    await writeFile(
      join(root, "main.js"),
      `document.body.textContent = ${JSON.stringify("padding ".repeat(200))}; document.body.onclick = () => import('./panel.js');`,
    );
    await writeFile(
      join(root, "panel.js"),
      "import './panel.css'; export { shared } from './shared.js';",
    );
    await writeFile(join(root, "shared.js"), "export const shared = 'panel';");
    await writeFile(join(root, "panel.css"), "body { color: red; }");
    const built = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [precompressAssets()],
      build: { minify: false, write: false },
    });
    assert.ok(!Array.isArray(built) && "output" in built);
    assert.ok(
      built.output.filter((entry) => entry.type === "chunk").length > 1,
    );
    let checked = 0;
    for (const entry of built.output) {
      if (entry.type !== "asset" || !/\.(?:gz|br)$/.test(entry.fileName))
        continue;
      const original = built.output.find(
        (candidate) =>
          candidate.fileName === entry.fileName.replace(/\.(?:gz|br)$/, ""),
      );
      assert.ok(original);
      const content =
        original.type === "chunk" ? original.code : original.source;
      const decompress = entry.fileName.endsWith(".gz")
        ? gunzipSync
        : brotliDecompressSync;
      assert.deepEqual(
        decompress(Buffer.from(entry.source)),
        Buffer.from(content),
      );
      checked++;
    }
    assert.ok(checked >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
