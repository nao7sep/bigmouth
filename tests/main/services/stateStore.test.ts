// state.json is the app's view-state store (side-pane widths + last workspace id),
// kept separate from the workspace registry and each per-workspace config. These
// tests cover the state semantics the persisted-store-separation convention asks
// for: lazy first write, self-heal on corruption, and per-field normalization.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, getAppRoot } from "@main/core/services/workspaceStore.js";
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
    expect(getUiState()).toEqual({ paneLeftWidth: 360, paneRightWidth: 480, activeWorkspaceId: "" });
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
    expect(reloaded).toEqual({ paneLeftWidth: 500, paneRightWidth: 480, activeWorkspaceId: "ws-42" });
  });

  it("merges a partial patch without disturbing the other fields", () => {
    initStateStore();
    updateUiState({ activeWorkspaceId: "ws-1", paneLeftWidth: 400, paneRightWidth: 600 });
    const after = updateUiState({ paneRightWidth: 700 });
    expect(after).toEqual({ paneLeftWidth: 400, paneRightWidth: 700, activeWorkspaceId: "ws-1" });
  });
});

describe("stateStore — self-healing", () => {
  it("falls back to defaults when state.json is unparseable, without throwing", () => {
    fs.writeFileSync(statePath(), "{ not valid json");
    expect(() => initStateStore()).not.toThrow();
    expect(getUiState()).toEqual({ paneLeftWidth: 360, paneRightWidth: 480, activeWorkspaceId: "" });
  });

  it("replaces a non-finite or wrong-typed field with its default on load", () => {
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ paneLeftWidth: "wide", paneRightWidth: Infinity, activeWorkspaceId: 7 }),
    );
    initStateStore();
    // Bad number/string fields heal to defaults; a numeric id is not a string, so it heals too.
    expect(getUiState()).toEqual({ paneLeftWidth: 360, paneRightWidth: 480, activeWorkspaceId: "" });
  });

  it("keeps the valid fields of a partially-bad file", () => {
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ paneLeftWidth: 520, paneRightWidth: null, activeWorkspaceId: "ws-keep" }),
    );
    initStateStore();
    expect(getUiState()).toEqual({ paneLeftWidth: 520, paneRightWidth: 480, activeWorkspaceId: "ws-keep" });
  });
});
