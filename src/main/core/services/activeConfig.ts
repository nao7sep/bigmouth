/**
 * The active AI config selection — view state, not workspace data. A workspace's
 * `config.json` carries the configs but not which one is "active": the selection
 * is remembered per workspace in the storage root's state.json (the UI-state store,
 * which is not recorded to the backup history), so it survives a relaunch without
 * committing a per-machine choice into the git-versioned workspace. When nothing is
 * selected, or the remembered id no longer names a config, the first config is active.
 *
 * The session map below is the working copy; state.json is its persisted mirror, and
 * is simply skipped when the state store has not been initialized.
 */

import type { StoredAiConfig } from "../shared/types.js";
import { getUiState, isStateStoreReady, updateUiState } from "./stateStore.js";

// workspaceId -> the explicitly selected config id for this session.
const selected = new Map<string, string>();

function persistedId(workspaceId: string): string | undefined {
  return isStateStoreReady() ? getUiState().activeAiConfigIds[workspaceId] : undefined;
}

/** Mirror a selection (or its removal, with an empty id) into state.json when it changed. */
function persist(workspaceId: string, id: string): void {
  if (!isStateStoreReady()) return;
  const current = getUiState().activeAiConfigIds;
  if ((current[workspaceId] ?? "") === id) return;
  const next = { ...current };
  if (id) next[workspaceId] = id;
  else delete next[workspaceId];
  updateUiState({ activeAiConfigIds: next });
}

/**
 * The effective active config id for a workspace: the selection (this session's, else
 * the remembered one) when it still names an existing config, otherwise the first
 * config, otherwise "" (no configs). Pure — it does not record the fallback, so the
 * active config tracks the config list without a stale selection lingering.
 */
export function resolveActiveConfigId(workspaceId: string, configs: StoredAiConfig[]): string {
  const sel = selected.get(workspaceId) ?? persistedId(workspaceId);
  if (sel && configs.some((c) => c.id === sel)) return sel;
  return configs[0]?.id ?? "";
}

/** Record the selection. An empty id clears it (back to the default). */
export function setActiveConfigId(workspaceId: string, id: string): void {
  if (id) selected.set(workspaceId, id);
  else selected.delete(workspaceId);
  persist(workspaceId, id);
}

/** Drop a workspace's selection — used when the workspace is removed. */
export function forgetWorkspace(workspaceId: string): void {
  selected.delete(workspaceId);
  persist(workspaceId, "");
}
