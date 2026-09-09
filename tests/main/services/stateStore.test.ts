// state.json is the app's view-state store (side-pane widths + last workspace id),
// kept separate from the workspace registry and each per-workspace config. These
// Tests cover lazy first write, corrupt-state fallback, and per-field normalization.

import { defaultUiState } from "@shared/types";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getAppRoot } from "@main/core/services/storagePaths.js";
import { initStateStore, getUiState, updateUiState } from "@main/core/services/stateStore.js";

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bigmouth-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function statePath(): string {
  return path.join(getAppRoot(), "state.json");
}

beforeEach(() => {
  process.env.BIGMOUTH_HOME = tempDir("stateroot");
  initAppDir();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("stateStore — first run", () => {
  it("returns defaults and does NOT materialize state.json on init", () => {
    initStateStore();
    expect(getUiState()).toEqual(defaultUiState());
    // Lazy: nothing written until there is real state to record.
    expect(fs.existsSync(statePath())).toBe(false);
  });
});

describe("stateStore — persistence", () => {
  it("retains native placement across unrelated state writes and reloads", () => {
    initStateStore();
    const placement = { normalBounds: { x: 89, y: 81, width: 1201, height: 749 }, mode: "normal" as const,
      windowsNormalBounds: { left: 111, top: 101, right: 1613, bottom: 1038 } };
    updateUiState({ windowPlacements: { main: placement } });
    updateUiState({ paneLeftWidth: 450 });
    expect(initStateStore().windowPlacements.main).toEqual(placement);
  });

  it("discards only malformed native geometry and preserves the compatible record", () => {
    const placement = { normalBounds: { x: 89, y: 81, width: 1201, height: 749 }, mode: "maximized",
      windowsNormalBounds: { left: 100, top: 100, right: 100, bottom: 800 } };
    fs.writeFileSync(statePath(), JSON.stringify({ paneLeftWidth: 450, windowPlacements: { main: placement } }));
    const state = initStateStore();
    expect(state.paneLeftWidth).toBe(450);
    expect(state.windowPlacements.main).toEqual({ ...placement, windowsNormalBounds: null });
  });

  it("writes state.json on the first update and reads it back on re-init", () => {
    initStateStore();
    const next = updateUiState({ activeWorkspaceId: "ws-42", paneLeftWidth: 500 });
    expect(next.activeWorkspaceId).toBe("ws-42");
    expect(next.paneLeftWidth).toBe(500);
    expect(fs.existsSync(statePath())).toBe(true);

    // A fresh store (simulating the next launch) rehydrates the persisted state.
    const reloaded = initStateStore();
    expect(reloaded).toEqual({ ...defaultUiState(), paneLeftWidth: 500, activeWorkspaceId: "ws-42" });
  });

  it("merges a partial patch without disturbing the other fields", () => {
    initStateStore();
    updateUiState({ activeWorkspaceId: "ws-1", paneLeftWidth: 400, paneRightWidth: 600 });
    const after = updateUiState({ paneRightWidth: 700 });
    expect(after).toEqual({
      ...defaultUiState(),
      paneLeftWidth: 400,
      paneRightWidth: 700,
      activeWorkspaceId: "ws-1",
    });
  });

  it("remembers the zoom level across a reload", () => {
    // Electron's zoom roles mutate webContents in memory only, so a user who
    // zoomed for readability was back at 100% on every launch, silently.
    initStateStore();
    updateUiState({ zoomLevel: 1.5 });

    initStateStore();

    expect(getUiState().zoomLevel).toBe(1.5);
  });

  it("falls back to the default zoom when the stored value is not a number", () => {
    fs.writeFileSync(statePath(), JSON.stringify({ zoomLevel: "big" }), "utf-8");
    initStateStore();
    expect(getUiState().zoomLevel).toBe(defaultUiState().zoomLevel);
  });
});

describe("stateStore — self-healing", () => {
  it("falls back to defaults when state.json is unparseable, without throwing", () => {
    fs.writeFileSync(statePath(), "{ not valid json");
    expect(() => initStateStore()).not.toThrow();
    expect(getUiState()).toEqual(defaultUiState());
  });

  it("replaces a non-finite or wrong-typed field with its default on load", () => {
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ paneLeftWidth: "wide", paneRightWidth: Infinity, activeWorkspaceId: 7 }),
    );
    initStateStore();
    // Bad number/string fields heal to defaults; a numeric id is not a string, so it heals too.
    expect(getUiState()).toEqual(defaultUiState());
  });

  it("keeps the valid fields of a partially-bad file", () => {
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ paneLeftWidth: 520, paneRightWidth: null, activeWorkspaceId: "ws-keep" }),
    );
    initStateStore();
    expect(getUiState()).toEqual({ ...defaultUiState(), paneLeftWidth: 520, activeWorkspaceId: "ws-keep" });
  });

  it("normalizes placement geometry and mode independently", () => {
    fs.writeFileSync(statePath(), JSON.stringify({
      activeWorkspaceId: "ws-keep",
      windowPlacements: {
        main: {
          normalBounds: { x: 10, y: 20, width: "wide", height: 800 },
          mode: "maximized",
        },
      },
    }));
    initStateStore();
    expect(getUiState().activeWorkspaceId).toBe("ws-keep");
    expect(getUiState().windowPlacements.main).toEqual({ normalBounds: null, mode: "maximized" });
  });
});
