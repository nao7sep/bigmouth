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
 * Unlike the registry, losing this file costs almost nothing — default pane
 * widths and a reopened workspace picker — which shapes two of its three rules
 * but not the third:
 *   - Materialized lazily: a missing file returns defaults WITHOUT writing (the
 *     convention's "state is written only once there is something to record").
 *   - Self-healing: an invalid file falls back to defaults because nothing here
 *     has recovery value.
 *   - Recorded, like every other managed text store. It used to be excluded on a
 *     churn argument, which the data-backup conventions answer directly: a text
 *     row is tiny, and the store's per-path hash dedup means a save that changes
 *     nothing writes nothing.
 */

import fs from "node:fs";
import type { UiState } from "../shared/types.js";
import { defaultUiState, type WindowBounds, type WindowPlacementRecord } from "@shared/types";
import { writeManagedText } from "../shared/atomicWrite.js";
import { getStateJsonPath } from "./storagePaths.js";
import { serializeError, warn } from "./logger.js";

let stateJsonPath: string | null = null;
let uiState: UiState | null = null;

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
    windowPlacements: normalizeWindowPlacements(source.windowPlacements, base.windowPlacements),
  };
}

function normalizeWindowPlacements(
  raw: unknown,
  fallback: UiState["windowPlacements"],
): UiState["windowPlacements"] {
  if (raw === undefined) return { main: cloneWindowPlacement(fallback.main) };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { main: cloneWindowPlacement(fallback.main) };
  }
  const source = raw as Record<string, unknown>;
  if (source.main === undefined) return { main: cloneWindowPlacement(fallback.main) };
  if (source.main === null) return { main: null };
  if (!source.main || typeof source.main !== "object" || Array.isArray(source.main)) {
    return { main: cloneWindowPlacement(fallback.main) };
  }

  const placement = source.main as Record<string, unknown>;
  return {
    main: {
      normalBounds: normalizeWindowBounds(placement.normalBounds, fallback.main?.normalBounds ?? null),
      mode:
        placement.mode === "normal" || placement.mode === "maximized"
          ? placement.mode
          : fallback.main?.mode ?? "maximized",
    },
  };
}

function normalizeWindowBounds(raw: unknown, fallback: WindowBounds | null): WindowBounds | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback ? { ...fallback } : null;
  const source = raw as Record<string, unknown>;
  const values = [source.x, source.y, source.width, source.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return fallback ? { ...fallback } : null;
  }
  return {
    x: source.x as number,
    y: source.y as number,
    width: source.width as number,
    height: source.height as number,
  };
}

function cloneWindowPlacement(value: WindowPlacementRecord | null): WindowPlacementRecord | null {
  return value
    ? { normalBounds: value.normalBounds ? { ...value.normalBounds } : null, mode: value.mode }
    : null;
}

/**
 * Resolves state.json under the storage root and loads it. Must run after
 * initAppDir() (it derives the path from getAppRoot()). A missing file leaves
 * defaults in memory without writing; an unreadable/invalid one self-heals to
 * defaults; the next deliberate view-state update replaces it.
 */
export function initStateStore(): UiState {
  stateJsonPath = getStateJsonPath();

  if (!fs.existsSync(stateJsonPath)) {
    // First run (or the user cleared it): defaults, written lazily on first update.
    uiState = defaultUiState();
    return uiState;
  }

  try {
    const raw = fs.readFileSync(stateJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // Parses but does not fit its shape: corrupt, same branch as bad JSON
      // (storage-path conventions) — never coerced and then overwritten by the
      // first pane drag.
      throw new Error("state.json does not contain a JSON object");
    }
    uiState = normalizeUiState(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Missing is the normal first-run case; state materializes on first use.
      uiState = defaultUiState();
      return uiState;
    }
    warn("state.json unreadable; using defaults", {
      error: serializeError(err),
      path: stateJsonPath,
    });
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
  // recorded: state.json is a durable JSON store under the storage root, and the
  // data-backup conventions record everything that is not binary, colocated with
  // binaries, or append-mode. It used to be excluded as "disposable view state",
  // which is not one of those three, on a churn argument the conventions answer
  // directly — and the store's own per-path hash dedup collapses a no-op save
  // anyway, so a splitter drag that changes nothing writes no row.
  writeManagedText(stateJsonPath, JSON.stringify(next, null, 2) + "\n");
  return next;
}
