// Minimal ambient declarations for the Node built-ins the test tree uses.
//
// The client is a browser package and deliberately carries no `@types/node`
// (see vite.config.ts), but Vitest runs the suite under Node, so a few tests
// read fixture files from disk at runtime. Rather than add a Node-types
// dependency to a browser package, declare just the small surface used here.
declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

// Vitest runs from the package root, so tests resolve fixtures via process.cwd().
declare const process: { cwd(): string };
