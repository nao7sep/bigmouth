// The storage root's config.json holds the app-wide settings (the theme). These
// tests cover first-run materialization, reading back, and the
// quarantine-then-reset recovery the storage-path conventions require.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getAppRoot } from "@main/core/services/storagePaths.js";
import {
  getAppSettingsLoad,
  initAppSettingsStore,
  saveAppSettings,
} from "@main/core/services/appSettingsStore.js";

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bigmouth-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function configPath(): string {
  return path.join(getAppRoot(), "config.json");
}

function quarantined(): string[] {
  return fs.readdirSync(getAppRoot()).filter((name) => /^config-.*\.invalid$/.test(name));
}

beforeEach(() => {
  process.env.BIGMOUTH_HOME = tempDir("appsettings");
  initAppDir();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("appSettingsStore", () => {
  it("materializes the defaults on first launch", () => {
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toEqual({ theme: "system", language: "system" });
    expect(getAppSettingsLoad()).toEqual({ settings: { theme: "system", language: "system" }, quarantinedTo: null });
  });

  it("reads a saved theme back without rewriting the file", () => {
    fs.writeFileSync(configPath(), '{ "theme": "dark" }');
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "system" });
    expect(fs.readFileSync(configPath(), "utf-8")).toBe('{ "theme": "dark" }');
  });

  it("follows the OS for an unrecognized theme name without treating it as corruption", () => {
    fs.writeFileSync(configPath(), '{ "theme": "sepia" }');
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(quarantined()).toEqual([]);
  });

  it.each([
    ["invalid JSON", "{ theme"],
    ["a non-object", "[]"],
    ["a wrong-typed theme", '{ "theme": true }'],
  ])("moves %s aside, resets, and reports where it went", (_label, body) => {
    fs.writeFileSync(configPath(), body);
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });

    const moved = quarantined();
    expect(moved).toHaveLength(1);
    expect(fs.readFileSync(path.join(getAppRoot(), moved[0]!), "utf-8")).toBe(body);
    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toEqual({ theme: "system", language: "system" });
    expect(getAppSettingsLoad().quarantinedTo).toBe(path.join(getAppRoot(), moved[0]!));
  });

  it("reads a saved language back, and follows the computer for an unknown one", () => {
    fs.writeFileSync(configPath(), '{ "theme": "dark", "language": "ko" }');
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "ko" });
    fs.writeFileSync(configPath(), '{ "language": "tlh" }');
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(quarantined()).toEqual([]);
  });

  it("saves only known keys", () => {
    initAppSettingsStore();
    expect(saveAppSettings({ theme: "light", extra: 1 } as never)).toEqual({ theme: "light", language: "system" });
    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toEqual({ theme: "light", language: "system" });
  });
});
