import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// __APP_VERSION__ is injected from package.json in electron.vite.config.ts for the
// build; mirror it here so renderer tests that render the About modal resolve it.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The tests run in two environments: the renderer tests (React components + DOM
// utilities) under jsdom, and everything else — the framework-free main-process
// core and the shared modules — under Node. Two projects keep each in its own
// environment while sharing the app's path aliases. Between them the two includes
// cover the whole tests tree, so no test file can fall outside both and go unrun.
// Vitest reruns everything when a root setup file changes, but not a project's
// own, so the main project's setup is named once and added to the triggers.
const mainSetup = "tests/main/setup.ts";

const alias = {
  "@shared": resolve("src/shared"),
  "@main": resolve("src/main"),
  "@renderer": resolve("src/renderer/src"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // setup.ts owns the backup-store handle and is registered before each
    // test file's temp-directory cleanup. Run hooks in registration order so
    // Windows releases SQLite before removing the directory it holds.
    sequence: { hooks: "list" },
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, `**/${mainSetup}`],
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
        define: {
          __APP_VERSION__: JSON.stringify(version),
        },
        test: {
          name: "main",
          environment: "node",
          // Everything the renderer project does not take, so a test in a new folder — or at the
          // root of tests/ — runs under Node instead of matching no project and never running at
          // all. Naming the folders here instead let a file outside them be type-checked, look
          // fine, and be silently skipped. tests/shared covers src/shared, the environment-neutral
          // modules both processes import: they must hold under Node and nothing in them is DOM.
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: [...configDefaults.exclude, "tests/renderer/**", "tests/live/**"],
          // Reset the data-backup store singleton after every test so each throwaway BIGMOUTH_HOME root
          // re-opens its own backups.sqlite3 instead of leaking a prior test's handle (see the file).
          setupFiles: [mainSetup],
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
