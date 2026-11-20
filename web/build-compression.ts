import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/** Precompress once at build time instead of spending CPU on each page load. */
export function precompressAssets(): Plugin {
  return {
    name: "precompress-assets",
    apply: "build",
    generateBundle: {
      // Vite rewrites dynamic-import preload dependencies in generateBundle.
      // Compress the final code, including those rewrites.
      order: "post",
      handler(_, bundle) {
        for (const entry of Object.values(bundle)) {
          if (!/\.(?:js|css|svg|json|wasm)$/.test(entry.fileName)) continue;
          const source = entry.type === "chunk" ? entry.code : entry.source;
          const bytes = Buffer.from(source);
          if (bytes.length < 1024) continue;
          const variants = [
            ["gz", gzipSync(bytes)],
            [
              "br",
              brotliCompressSync(bytes, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
              }),
            ],
          ] as const;
          for (const [extension, compressed] of variants) {
            if (compressed.length >= bytes.length) continue;
            this.emitFile({
              type: "asset",
              fileName: `${entry.fileName}.${extension}`,
              source: compressed,
            });
          }
        }
      },
    },
  };
}
