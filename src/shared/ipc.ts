// The cross-process IPC contract: the typed surface the preload bridge exposes on
// `window.bigmouth`, implemented in preload (as ipcRenderer.invoke / event
// subscriptions) and backed by ipcMain handlers in the main process. Per the
// tsconfig-env-split-conventions this interface lives in `shared` so neither side
// imports a type from the other across the process line, which would drag
// `electron` → @types/node into the renderer and defeat the isolation.
//
// Phase 0 only stands the contract up. Phase 2 fills it in, one method per
// function in the old HTTP `api.ts`, as the renderer's fetch layer is ported to
// IPC.
export interface BigMouthApi {
  // populated in Phase 2
}
