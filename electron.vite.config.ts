import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

import { withCspMeta } from "./src/shared/csp";

// Single source of truth for the app version: package.json. Injected into the
// renderer as __APP_VERSION__ so the About modal never drifts from the release.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Build only: the packaged renderer loads over file://, where a response-header
// CSP cannot apply, so the policy has to be in the document. Dev is left alone —
// it is served over http, and Vite's HMR client and React Fast Refresh need the
// looser policy the dev server already applies.
const contentSecurityPolicy = {
  name: "bigmouth-csp-meta",
  apply: "build",
  transformIndexHtml: { order: "post", handler: withCspMeta },
} as const;

export default defineConfig({
  main: {
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    build: {
      outDir: "out/main",
      rollupOptions: {
        // The records reader's thread is its own entry beside index.js, where
        // recordsReader.ts looks for it.
        input: {
          index: resolve("src/main/index.ts"),
          "records-reader-worker": resolve("src/main/core/services/recordsReaderWorker.ts"),
        },
        output: {
          entryFileNames: "[name].js",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@main": resolve("src/main"),
      },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    server: {
      host: "127.0.0.1",
      port: 26263,
      strictPort: true,
    },
    build: {
      outDir: resolve("out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          records: resolve("src/renderer/records.html"),
        },
      },
      minify: true,
      // Loaded from disk, not over a network: the default 500 kB warning measures
      // transfer cost. 2000 keeps a runaway bundle loud without flagging the
      // editor on every build.
      chunkSizeWarningLimit: 2000,
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
      },
    },
    plugins: [react(), contentSecurityPolicy],
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
  },
});
