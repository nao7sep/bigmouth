/**
 * The active AI config selection — volatile session state, deliberately NOT
 * persisted. A workspace's `config.json` carries the configs but not which one
 * is "active": on each launch the active config defaults to the first one, and
 * the user may switch it for the session in Settings. (This replaced a persisted
 * `activeId` that committed a per-machine choice into the git-versioned workspace.)
 */

import type { StoredAiConfig } from "../shared/types.js";

// workspaceId -> the explicitly selected config id for this session.
const selected = new Map<string, string>();

/**
 * The effective active config id for a workspace: the explicit session selection
 * when it still names an existing config, otherwise the first config, otherwise
 * "" (no configs). Pure — it does not record the fallback, so the active config
 * tracks the config list without a stale selection lingering.
 */
export function resolveActiveConfigId(workspaceId: string, configs: StoredAiConfig[]): string {
  const sel = selected.get(workspaceId);
  if (sel && configs.some((c) => c.id === sel)) return sel;
  return configs[0]?.id ?? "";
}

/** Record the session selection. An empty id clears it (back to the default). */
export function setActiveConfigId(workspaceId: string, id: string): void {
  if (id) selected.set(workspaceId, id);
  else selected.delete(workspaceId);
}

/** Drop a workspace's session selection — used when the workspace is removed. */
export function forgetWorkspace(workspaceId: string): void {
  selected.delete(workspaceId);
}
