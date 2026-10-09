/**
 * UI-state I/O.
 *
 * Manages ~/.bigmouth/state.json — the app's ephemeral view state (side-pane
 * intent widths, zoom level, last active workspace id, and the records window's
 * list width). It is a distinct persisted KIND
 * from the workspace registry (workspaces.json) and every per-workspace
 * config.json, so it gets its own store and type (persisted-store-separation
 * conventions): a settings reset must not touch it, and its splitter-drag churn
 * must never rewrite a config file.
 *
 * Unlike the registry, losing this file costs almost nothing — default pane
 * widths and a reopened workspace picker — which
 * shapes all of its rules:
 *   - Materialized lazily: a missing file returns defaults WITHOUT writing (the
 *     convention's "state is written only once there is something to record").
 *   - Self-healing: an invalid file falls back to defaults because nothing here
 *     has recovery value.
 *   - Not recorded to the data-backup history: it is volatile state and nothing
 *     else (window placement, zoom, last selection), which the data-backup
 *     conventions exclude. It is still written atomically.
 */

import type { UiState } from "../shared/types.js";
import { defaultUiState } from "@shared/types";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { jsonStoreText, readJsonStore } from "../shared/storeFormat.js";
import { getStateJsonPath } from "./storagePaths.js";
import { serializeError, warn } from "./logger.js";

let stateJsonPath: string | null = null;
let uiState: UiState | null = null;
// False when this launch must leave state.json as it is: a newer build wrote it, or it could not be read.
let writable = true;

/**
 * Coerces an arbitrary parsed value into a valid UiState, replacing any bad or
 * missing field with its default. Pane widths are only checked for being finite
 * numbers here — the renderer clamps them to its own layout bounds on read, so the
 * bounds stay in one place (paneConstants) rather than being duplicated in main.
 */
function normalizeUiState(raw: unknown): UiState {
  const base = defaultUiState();
  if (!raw || typeof raw !== "object") return base;
  const source = raw as Record<string, unknown>;
  return {
    paneLeftWidth:
      typeof source.paneLeftWidth === "number" && Number.isFinite(source.paneLeftWidth)
        ? source.paneLeftWidth
        : base.paneLeftWidth,
    paneRightWidth:
      typeof source.paneRightWidth === "number" && Number.isFinite(source.paneRightWidth)
        ? source.paneRightWidth
        : base.paneRightWidth,
    activeWorkspaceId:
      typeof source.activeWorkspaceId === "string" ? source.activeWorkspaceId : base.activeWorkspaceId,
    zoomLevel:
      typeof source.zoomLevel === "number" && Number.isFinite(source.zoomLevel)
        ? source.zoomLevel
        : base.zoomLevel,
    recordsListWidth:
      typeof source.recordsListWidth === "number" && Number.isFinite(source.recordsListWidth)
        ? source.recordsListWidth
        : base.recordsListWidth,
  };
}

/**
 * Resolves state.json under the storage root and loads it. Must run after
 * initAppDir() (it derives the path from getAppRoot()). A missing file leaves
 * defaults in memory without writing; an invalid one is view state only, so it
 * falls back to defaults and the next deliberate view-state update replaces it.
 * One a newer version of BigMouth wrote, or one that could not be read at all,
 * is left exactly as it is: this launch keeps its view state in memory only.
 */
export function initStateStore(): UiState {
  stateJsonPath = getStateJsonPath();
  uiState = defaultUiState();
  writable = true;

  const read = readJsonStore("state", stateJsonPath);
  switch (read.kind) {
    case "absent":
      // First run (or the user cleared it): defaults, written lazily on first update.
      break;
    case "newer":
      writable = false;
      warn("state.json was written by a newer version of BigMouth; left unchanged, view state is kept in memory", {
        path: stateJsonPath,
        formatVersion: read.version,
      });
      break;
    case "inaccessible":
      writable = false;
      warn("state.json could not be read; left unchanged, view state is kept in memory", {
        detail: read.detail,
        error: serializeError(read.error),
        path: stateJsonPath,
      });
      break;
    case "unreadable":
      // Parsing but not fitting its shape is corrupt, same branch as bad JSON:
      // never coerced, and replaced by the next view-state update.
      warn("state.json unreadable; using defaults", {
        detail: read.detail,
        ...(read.error ? { error: serializeError(read.error) } : {}),
        path: stateJsonPath,
      });
      break;
    case "read":
      uiState = normalizeUiState(read.value);
      break;
  }
  return uiState;
}

function ensureLoaded(): UiState {
  if (!uiState) throw new Error("stateStore not initialized — call initStateStore() first");
  return uiState;
}

export function getUiState(): UiState {
  return ensureLoaded();
}

/** True once initStateStore() has run — for callers that must also work without it. */
export function isStateStoreReady(): boolean {
  return uiState !== null && stateJsonPath !== null;
}

/**
 * Merges a partial patch into the UI state, normalizes, persists, and returns the
 * new state. This is where state.json first materializes — a fresh install writes
 * it only once the user drags a pane or picks a workspace.
 */
export function updateUiState(patch: Partial<UiState>): UiState {
  if (!stateJsonPath) throw new Error("stateStore not initialized — call initStateStore() first");
  const next = normalizeUiState({ ...ensureLoaded(), ...patch });
  uiState = next;
  if (!writable) return next;
  // not recorded: state.json is volatile state and nothing else (pane widths, zoom,
  // last selections), so the data-backup conventions keep it out of backups.sqlite3.
  // It is still written atomically (temp file, then rename).
  writeFileAtomic(stateJsonPath, jsonStoreText("state", { ...next }));
  return next;
}
