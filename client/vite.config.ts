/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom because safeMarkdown's DOMPurify needs a DOM `window`.
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Pin a fixed, DST-free zone so local-time formatting is deterministic
    // regardless of where the suite runs. Set here (Node-side test infra)
    // rather than via `process.env` in a test, since the client is a browser
    // package and intentionally carries no Node type definitions.
    env: { TZ: "Asia/Tokyo" },
  },
  server: {
    // Pinned to 5273 instead of Vite's default 5173 so the launcher's
    // port-kill (scripts/run-dev.command) only ever clears this app's port and
    // never some other local dev server squatting the shared 5173 default.
    port: 5273,
    proxy: {
      "/api": "http://127.0.0.1:3141",
      "/assets": "http://127.0.0.1:3141",
    },
  },
});
