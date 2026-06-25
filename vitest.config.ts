import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

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
