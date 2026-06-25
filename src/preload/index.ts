import { contextBridge } from "electron";

import type { BigMouthApi } from "@shared/ipc";

// The bridge the renderer talks to instead of HTTP. Phase 0 stands it up empty;
// the methods land in Phase 2 as the old fetch-based `api.ts` is ported to
// ipcRenderer.invoke calls and event subscriptions. Typed against the shared
// contract so the renderer and main can never disagree on its shape.
const api: BigMouthApi = {};

contextBridge.exposeInMainWorld("bigmouth", api);
