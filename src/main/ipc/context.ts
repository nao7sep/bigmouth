import { getWorkspace } from "../core/services/workspaceStore.js";

// Replaces the old `resolveWorkspace` Express middleware (which set
// `res.locals.dataDir`): every workspace-scoped IPC handler resolves its data
// directory from the `wsId` argument here. An unknown id throws the same
// "Workspace not found" message the HTTP layer returned as 404 — surfaced to the
// renderer as a rejected `invoke`.
export function resolveWorkspace(wsId: string) {
  const ws = getWorkspace(wsId);
  if (!ws) throw new Error("Workspace not found");
  return ws;
}
