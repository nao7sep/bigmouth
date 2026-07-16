/**
 * UI-state I/O.
 *
 * Manages ~/.bigmouth/state.json — the app's ephemeral view state (side-pane
 * intent widths + the last active workspace id). It is a distinct persisted KIND
 * from the workspace registry (workspaces.json) and every per-workspace
 * config.json, so it gets its own store and type (persisted-store-separation
 * conventions): a settings reset must not touch it, and its splitter-drag churn
 * must never rewrite a config file.
 *
 * Unlike the registry, this file is disposable:
 *   - Written with the bare atomic writer, NOT the managed-text choke point — it
 *     is deliberately NOT recorded to the data-backup store. Losing it costs only
 *     default pane widths and a reopened workspace picker; recording every splitter
 *     drag would just churn the backup history (data-backup conventions: the
 *     no-record sites each state their reason inline, as here).
 *   - Materialized lazily: a missing file returns defaults WITHOUT writing (the
 *     convention's "state is written only once there is something to record").
 *   - Self-healing: a present-but-invalid file falls back to defaults rather than
 *     failing loud, because nothing here is worth preserving.
 */

import fs from "node:fs";
import path from "node:path";
import type { UiState } from "../shared/types.js";
import { writeFileAtomic } from "../shared/atomicWrite.js";
import { getAppRoot } from "./workspaceStore.js";
import { warn } from "./logger.js";

let stateJsonPath: string | null = null;
let uiState: UiState | null = null;

function defaultUiState(): UiState {
  // Mirrors @shared/types defaultUiState / DEFAULT_PANE_*_WIDTH (the two type
  // worlds can't import each other). Kept in sync by hand.
  return {
    paneLeftWidth: 360,
    paneRightWidth: 480,
    activeWorkspaceId: "",
  };
}

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
  };
}

/**
 * Resolves state.json under the storage root and loads it. Must run after
 * initAppDir() (it derives the path from getAppRoot()). A missing file leaves
 * defaults in memory without writing; an unreadable/invalid one self-heals to
 * defaults and is left on disk untouched (the next update overwrites it).
 */
export function initStateStore(): UiState {
  stateJsonPath = path.join(getAppRoot(), "state.json");

  if (!fs.existsSync(stateJsonPath)) {
    // First run (or the user cleared it): defaults, written lazily on first update.
    uiState = defaultUiState();
    return uiState;
  }

  try {
    const raw = fs.readFileSync(stateJsonPath, "utf-8");
    uiState = normalizeUiState(JSON.parse(raw) as unknown);
  } catch (err) {
    warn("state.json unreadable; using defaults", { error: String(err) });
    uiState = defaultUiState();
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

/**
 * Merges a partial patch into the UI state, normalizes, persists, and returns the
 * new state. This is where state.json first materializes — a fresh install writes
 * it only once the user drags a pane or picks a workspace.
 */
export function updateUiState(patch: Partial<UiState>): UiState {
  if (!stateJsonPath) throw new Error("stateStore not initialized — call initStateStore() first");
  const next = normalizeUiState({ ...ensureLoaded(), ...patch });
  uiState = next;
  // not recorded: state.json is disposable view state, deliberately kept out of the
  // data-backup store (see the file header) — write through the bare atomic writer.
  writeFileAtomic(stateJsonPath, JSON.stringify(next, null, 2) + "\n");
  return next;
}
