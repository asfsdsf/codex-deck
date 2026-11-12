import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { build } from "vite";
import { minifyWebChunks, webVendorChunk } from "../../web/build-chunks";
import { precompressAssets } from "../../web/build-compression";

test("UI rebuilds reuse minified vendors and keep terminal and Shiki assets lazy", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "web-chunks-")));
  const libraries = new Map([
    [
      "stable-lib",
      `export function stableLibraryOperation(stableLibraryParameterForTest) { return stableLibraryParameterForTest + ${JSON.stringify("padding ".repeat(200))}; }`,
    ],
    [
      "@xterm/xterm",
      "export function Terminal(terminalParameterForTest) { this.value = terminalParameterForTest; }",
    ],
    ["@shikijs/langs/typescript", "export default { name: 'typescript' };"],
    ["@shikijs/themes/light", "export default { name: 'light' };"],
    [
      "@shikijs/engine-oniguruma/wasm-inlined",
      "export default 'on-demand wasm';",
    ],
  ]);
  const modulePaths = new Map(
    [...libraries.keys()].map((name) => [
      name,
      join(root, "node_modules", name, "index.js"),
    ]),
  );
  // Match the real package-local WASM file, rather than a package subdirectory.
  modulePaths.set(
    "@shikijs/engine-oniguruma/wasm-inlined",
    join(root, "node_modules/@shikijs/engine-oniguruma/dist/wasm-inlined.js"),
  );
  try {
    await writeFile(
      join(root, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    await writeFile(
      join(root, "terminal.js"),
      "import { Terminal } from '@xterm/xterm'; export function openTerminal(value) { return new Terminal(value); }",
    );
    const buildRevision = async (revision: string) => {
      await writeFile(
        join(root, "main.js"),
        `import { stableLibraryOperation } from 'stable-lib';
         globalThis.result = stableLibraryOperation(${JSON.stringify(revision)});
         globalThis.openTerminal = () => import('./terminal.js');
         globalThis.loadLanguage = () => import('@shikijs/langs/typescript');
         globalThis.loadTheme = () => import('@shikijs/themes/light');
         globalThis.loadWasm = () => import('@shikijs/engine-oniguruma/wasm-inlined');`,
      );
      const built = await build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [
          {
            name: "fixture-libraries",
            resolveId: (id) => modulePaths.get(id),
            load(id) {
              const name = [...modulePaths].find(
                ([, path]) => path === id,
              )?.[0];
              return name ? libraries.get(name) : undefined;
            },
          },
          minifyWebChunks(),
          precompressAssets(),
        ],
        build: {
          minify: false,
          write: false,
          rollupOptions: {
            output: {
              manualChunks: webVendorChunk,
            },
          },
        },
      });
      assert.ok(!Array.isArray(built) && "output" in built);
      return built.output;
    };
    const first = await buildRevision("first UI revision");
    const second = await buildRevision("second UI revision");
    const chunks = first.filter((entry) => entry.type === "chunk");
    const entry = chunks.find((chunk) => chunk.isEntry)!;
    const vendor = chunks.find((chunk) => chunk.name === "vendor")!;
    const terminal = chunks.find((chunk) => chunk.name === "vendor-terminal")!;
    assert.ok(entry && vendor && terminal);
    assert.notEqual(
      entry.fileName,
      second.find((chunk) => chunk.type === "chunk" && chunk.isEntry)?.fileName,
    );
    for (const chunk of [vendor, terminal]) {
      const cached = second.find((asset) => asset.fileName === chunk.fileName);
      assert.ok(cached?.type === "chunk");
      assert.equal(cached.code, chunk.code);
    }
    assert.doesNotMatch(vendor.code, /stableLibraryParameterForTest/);
    assert.match(terminal.code, /terminalParameterForTest/);
    assert.doesNotMatch(entry.code, /\bstableLibraryOperation\b/);

    const initialChunks = new Set<string>();
    const visit = (fileName: string) => {
      if (initialChunks.has(fileName)) return;
      initialChunks.add(fileName);
      const chunk = chunks.find((candidate) => candidate.fileName === fileName);
      chunk?.imports.forEach(visit);
    };
    visit(entry.fileName);
    assert.ok(initialChunks.has(vendor.fileName));
    for (const [name, modulePath] of modulePaths) {
      if (name === "stable-lib") continue;
      const chunk = chunks.find((candidate) =>
        candidate.moduleIds.includes(modulePath),
      );
      assert.ok(chunk, `${name} must have a chunk`);
      assert.ok(!initialChunks.has(chunk.fileName), `${name} must stay lazy`);
    }

    let compressedVariants = 0;
    for (const asset of first) {
      if (asset.type !== "asset" || !/\.(?:gz|br)$/.test(asset.fileName))
        continue;
      const original = first.find(
        (candidate) =>
          candidate.fileName === asset.fileName.replace(/\.(?:gz|br)$/, ""),
      );
      assert.ok(original);
      const decompress = asset.fileName.endsWith(".gz")
        ? gunzipSync
        : brotliDecompressSync;
      assert.deepEqual(
        decompress(Buffer.from(asset.source)),
        Buffer.from(
          original.type === "chunk" ? original.code : original.source,
        ),
      );
      compressedVariants++;
    }
    assert.ok(compressedVariants >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
