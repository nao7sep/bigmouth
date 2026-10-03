// state.json is the app's view-state store (side-pane widths + last workspace id),
// kept separate from the workspace registry and each per-workspace config. These
// Tests cover lazy first write, corrupt-state fallback, and per-field normalization.

import { defaultUiState } from "@shared/types";
import { RECORDS_LIST_WIDTH } from "@shared/layout";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getAppRoot } from "@main/core/services/storagePaths.js";
import { initStateStore, getUiState, updateUiState } from "@main/core/services/stateStore.js";
import { resolveActiveConfigId, setActiveConfigId } from "@main/core/services/activeConfig.js";
import type { StoredAiConfig } from "@main/core/shared/types.js";

const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
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
  process.env.BIGMOUTH_DATA_DIR = tempDir("stateroot");
  initAppDir();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
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
});

describe("stateStore — selected AI config", () => {
  const configs = [{ id: "c1" }, { id: "c2" }] as StoredAiConfig[];

  it("restores the selected AI config per workspace after a relaunch", () => {
    initStateStore();
    setActiveConfigId("ws-a", "c2");
    setActiveConfigId("ws-b", "c1");
    expect(JSON.parse(fs.readFileSync(statePath(), "utf-8")).activeAiConfigIds).toEqual({ "ws-a": "c2", "ws-b": "c1" });

    // A fresh store reads the persisted selection.
    initStateStore();
    expect(getUiState().activeAiConfigIds).toEqual({ "ws-a": "c2", "ws-b": "c1" });
  });

  it("resolves the active config from state.json when this session selected nothing", () => {
    fs.writeFileSync(statePath(), JSON.stringify({ activeAiConfigIds: { "ws-file": "c2" } }));
    initStateStore();
    expect(resolveActiveConfigId("ws-file", configs)).toBe("c2");
  });

  it("ignores a stored id that no longer exists, falling back to the first config", () => {
    fs.writeFileSync(statePath(), JSON.stringify({ activeAiConfigIds: { "ws-gone": "ghost" } }));
    initStateStore();
    expect(resolveActiveConfigId("ws-gone", configs)).toBe("c1");
  });

  it("drops malformed entries on load", () => {
    fs.writeFileSync(statePath(), JSON.stringify({ activeAiConfigIds: { ok: "c1", bad: 7, empty: "" } }));
    initStateStore();
    expect(getUiState().activeAiConfigIds).toEqual({ ok: "c1" });
  });
});

describe("stateStore — records list width", () => {
  it("keeps the dragged width across a relaunch, defaulting until one is saved", () => {
    initStateStore();
    expect(getUiState().recordsListWidth).toBe(RECORDS_LIST_WIDTH.default);
    updateUiState({ recordsListWidth: 512 });

    initStateStore();
    expect(getUiState().recordsListWidth).toBe(512);
  });

  it("falls back to the default for a width that is not a number", () => {
    fs.writeFileSync(statePath(), JSON.stringify({ recordsListWidth: "wide" }));
    initStateStore();
    expect(getUiState().recordsListWidth).toBe(RECORDS_LIST_WIDTH.default);
  });
});
