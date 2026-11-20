import { transformWithEsbuild, type Plugin } from "vite";

function npmPackage(id: string): string | undefined {
  const path = id.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const offset = path.lastIndexOf(marker);
  if (offset === -1) return undefined;
  const parts = path.slice(offset + marker.length).split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Keep dependencies cached across UI edits without making lazy assets eager. */
export function webVendorChunk(id: string): string | undefined {
  // Shared CommonJS interop must not make the main vendor chunk depend on xterm.
  if (id.includes("commonjsHelpers.js")) return "vendor";
  const name = npmPackage(id);
  if (!name) return undefined;
  if (name.startsWith("@xterm/")) return "vendor-terminal";
  if (
    name === "@shikijs/langs" ||
    name === "@shikijs/themes" ||
    ((name === "shiki" || name === "@shikijs/engine-oniguruma") &&
      /[/\\]wasm[^/\\]*\.[cm]?js(?:$|\?)/.test(id))
  ) {
    return undefined;
  }
  return "vendor";
}

/** Preserve xterm's minification workaround while minifying all other chunks. */
export function minifyWebChunks(): Plugin {
  let target: string | string[] = "esnext";
  let sourcemap = false;
  return {
    name: "minify-web-chunks",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      target = config.build.target || "esnext";
      sourcemap = Boolean(config.build.sourcemap);
    },
    renderChunk: {
      // Run after Vite's target transpilation, before chunk hashes and compression.
      order: "post",
      async handler(code, chunk) {
        if (
          Object.keys(chunk.modules).some((id) =>
            npmPackage(id)?.startsWith("@xterm/"),
          )
        ) {
          return null;
        }
        return transformWithEsbuild(code, chunk.fileName, {
          loader: "js",
          format: "esm",
          target,
          sourcemap,
          minify: true,
        });
      },
    },
  };
}
