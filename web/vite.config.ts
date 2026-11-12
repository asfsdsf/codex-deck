import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { precompressAssets } from "./build-compression";
import { minifyWebChunks, webVendorChunk } from "./build-chunks";

export default defineConfig({
  plugins: [react(), tailwindcss(), minifyWebChunks(), precompressAssets()],
  root: resolve(__dirname),
  base: "/",
  resolve: {
    alias: {
      "@codex-deck/api": resolve(__dirname, "../api/storage.ts"),
      "@zuoyehaoduoa/wire": resolve(__dirname, "../wire/src/index.ts"),
    },
  },
  server: {
    port: 12000,
    proxy: {
      "/api/": {
        target: "http://localhost:12001",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.url?.includes("/stream")) {
              proxyReq.setHeader("Cache-Control", "no-cache");
              proxyReq.setHeader("Connection", "keep-alive");
            }
          });
          proxy.on("proxyRes", (proxyRes, req) => {
            if (req.url?.includes("/stream")) {
              proxyRes.headers["cache-control"] = "no-cache";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
  build: {
    outDir: resolve(__dirname, "../dist/web"),
    emptyOutDir: true,
    // minifyWebChunks minifies everything except the isolated xterm chunk:
    // esbuild minification can break xterm's requestMode at runtime.
    minify: false,
    cssMinify: "esbuild",
    rollupOptions: {
      output: {
        manualChunks: webVendorChunk,
      },
    },
  },
});
