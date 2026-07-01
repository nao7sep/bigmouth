import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// __APP_VERSION__ is injected from package.json in electron.vite.config.ts for the
// build; mirror it here so renderer tests that render the About modal resolve it.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The tests run in two environments: the main-process tests (the framework-free
// core) under Node, and the renderer tests (React components + DOM utilities)
// under jsdom. Two projects keep each in its own environment while sharing the
// app's path aliases.
const alias = {
  "@shared": resolve("src/shared"),
  "@main": resolve("src/main"),
  "@renderer": resolve("src/renderer/src"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      // One V8 coverage report across both projects (main + renderer). `include`
      // spans all source so the report flags logic no test reaches, not just a
      // score for what is reached.
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      // Excluded as framework wiring with no decision to cover:
      exclude: [
        "src/main/index.ts", // Electron main entry / bootstrap
        "src/preload/**", // contextBridge wiring
        "src/renderer/src/main.tsx", // React DOM mount
        "src/renderer/src/vite-env.d.ts",
        "**/*.d.ts",
      ],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "main",
          environment: "node",
          include: ["tests/main/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        plugins: [react()],
        define: {
          __APP_VERSION__: JSON.stringify(version),
        },
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["tests/renderer/**/*.test.{ts,tsx}"],
          // Pin a fixed, DST-free zone so local-time formatting is deterministic.
          env: { TZ: "Asia/Tokyo" },
        },
      },
    ],
  },
});
