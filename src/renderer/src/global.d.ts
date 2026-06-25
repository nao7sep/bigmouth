import type { BigMouthApi } from "@shared/ipc";

// The preload exposes the IPC bridge on `window.bigmouth`. Typed against the
// shared contract (never a type imported from preload) per the
// tsconfig-env-split-conventions, so the renderer program never pulls in
// `electron` / `@types/node`.
declare global {
  interface Window {
    bigmouth: BigMouthApi;
  }
}

export {};
