import { getWorkspace } from "../core/services/workspaceStore.js";

// Every workspace-scoped IPC handler resolves its data directory from the `wsId`
// argument here. An unknown id throws "Workspace not found", surfaced to the
// renderer as a rejected `invoke`.
export function resolveWorkspace(wsId: string) {
  const ws = getWorkspace(wsId);
  if (!ws) throw new Error("Workspace not found");
  return ws;
}
