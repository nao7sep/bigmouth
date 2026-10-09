// The storage root's config.json holds the app-wide settings (the theme). These
// tests cover sparse writes and recovery without seeding defaults.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as logger from "@main/core/services/logger.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getAppRoot } from "@main/core/services/storagePaths.js";
import { NewerFormatError, UnreadableStoreError } from "@main/core/shared/storeFormat.js";
import { QuarantineError } from "@main/core/shared/quarantine.js";
import { carriedMessage } from "@shared/i18n/carriedMessage";
import { message } from "@shared/i18n/translate";
import {
  getAppSettingsLoad,
  initAppSettingsStore,
  saveAppSettings,
} from "@main/core/services/appSettingsStore.js";

const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
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
  process.env.BIGMOUTH_DATA_DIR = tempDir("appsettings");
  initAppDir();
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("appSettingsStore", () => {
  it("leaves a file it could not read in place, uses built-ins, tells the user, and refuses saves", () => {
    // A directory where the file should be fails the read itself, as a permission error does.
    fs.mkdirSync(configPath());
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(getAppSettingsLoad().notice).toEqual(message("app.settingsInaccessible", { path: configPath() }));
    expect(() => saveAppSettings({ theme: "dark" })).toThrow(UnreadableStoreError);
    expect(fs.statSync(configPath()).isDirectory()).toBe(true);
    expect(quarantined()).toEqual([]);
  });

  it("keeps defaults in memory on first launch", () => {
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(fs.existsSync(configPath())).toBe(false);
    expect(getAppSettingsLoad()).toEqual({ settings: { theme: "system", language: "system" }, notice: null });
  });

  it("reads a saved theme back without rewriting the file", () => {
    fs.writeFileSync(configPath(), '{ "formatVersion": 1, "theme": "dark" }');
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "system" });
    expect(fs.readFileSync(configPath(), "utf-8")).toBe('{ "formatVersion": 1, "theme": "dark" }');
  });

  it("follows the OS for an unrecognized theme name without treating it as corruption", () => {
    fs.writeFileSync(configPath(), '{ "formatVersion": 1, "theme": "sepia" }');
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(quarantined()).toEqual([]);
  });

  it.each([
    ["invalid JSON", "{ theme"],
    ["a non-object", "[]"],
  ])("moves %s aside, resets, and reports where it went", (_label, body) => {
    fs.writeFileSync(configPath(), body);
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });

    const moved = quarantined();
    expect(moved).toHaveLength(1);
    expect(fs.readFileSync(path.join(getAppRoot(), moved[0]!), "utf-8")).toBe(body);
    expect(fs.existsSync(configPath())).toBe(false);
    expect(getAppSettingsLoad().notice).toEqual(
      message("app.settingsRecovered", { path: path.join(getAppRoot(), moved[0]!) }),
    );
  });

  it("reads a saved language back, and follows the computer for an unknown one", () => {
    fs.writeFileSync(configPath(), '{ "formatVersion": 1, "theme": "dark", "language": "ko" }');
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "ko" });
    fs.writeFileSync(configPath(), '{ "formatVersion": 1, "language": "tlh" }');
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(quarantined()).toEqual([]);
  });

  it("saves only known keys", () => {
    initAppSettingsStore();
    expect(saveAppSettings({ theme: "light", extra: 1 } as never)).toEqual({ theme: "light", language: "system" });
    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toEqual({ formatVersion: 1, theme: "light" });
  });
});

it("ignores invalid set shapes without quarantining valid neighbours", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ formatVersion: 1, theme: true, language: "ja" }));
  expect(initAppSettingsStore()).toEqual({ theme: "system", language: "ja" });
  expect(quarantined()).toEqual([]);
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ formatVersion: 1, theme: true, language: "ja" });
});

it("changing one set keeps another known copy and a key this build does not know", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ formatVersion: 1, laterSet: 1, theme: "dark" }));
  initAppSettingsStore();
  saveAppSettings({ theme: "dark", language: "ja" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ formatVersion: 1, theme: "dark", language: "ja", laterSet: 1 });
});

it("a save removes each set equal to its built-in and keeps the file", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ formatVersion: 1, theme: "dark", language: "ja" }));
  initAppSettingsStore();
  saveAppSettings({ theme: "system", language: "ja" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ formatVersion: 1, language: "ja" });
  saveAppSettings({ theme: "system", language: "system" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ formatVersion: 1 });
});

it("an invalid set is kept as stored until the user changes it", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ formatVersion: 1, theme: true, language: "ja" }));
  initAppSettingsStore();
  saveAppSettings({ theme: "system", language: "en" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ formatVersion: 1, language: "en", theme: true });
  saveAppSettings({ theme: "dark", language: "en" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ formatVersion: 1, theme: "dark", language: "en" });
});

it("saving built-ins on a fresh install creates no file", () => {
  initAppSettingsStore();
  saveAppSettings({ theme: "system", language: "system" });
  expect(fs.existsSync(configPath())).toBe(false);
});

it("warns on each load of an invalid app set and names its key", () => {
  const warning = vi.spyOn(logger, "warn");
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ formatVersion: 1, theme: "sepia" }));
    initAppSettingsStore();
    initAppSettingsStore();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: "theme" }));
  } finally { warning.mockRestore(); }
});

describe("appSettingsStore format version", () => {
  it("reads a file without its format version as this build's format", () => {
    fs.writeFileSync(configPath(), '{ "theme": "dark" }');
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "system" });
    expect(getAppSettingsLoad().notice).toBeNull();
    expect(quarantined()).toEqual([]);
  });

  it("moves damaged content aside and reports where it went", () => {
    const body = '{ "theme": ';
    fs.writeFileSync(configPath(), body);
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    const moved = quarantined();
    expect(moved).toHaveLength(1);
    expect(fs.readFileSync(path.join(getAppRoot(), moved[0]!), "utf-8")).toBe(body);
    expect(getAppSettingsLoad().notice).toEqual(
      message("app.settingsRecovered", { path: path.join(getAppRoot(), moved[0]!) }),
    );
  });

  it("writes this build's format version and reads it back", () => {
    initAppSettingsStore();
    saveAppSettings({ theme: "dark", language: "system" });
    expect(fs.readFileSync(configPath(), "utf8")).toBe('{\n  "formatVersion": 1,\n  "theme": "dark"\n}\n');
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "system" });
  });

  it("leaves a file a newer version wrote byte-identical, uses built-ins, tells the user, and refuses saves", () => {
    const body = '{ "formatVersion": 2, "theme": "dark", "future": true }';
    fs.writeFileSync(configPath(), body);

    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(getAppSettingsLoad().notice).toEqual(message("app.settingsNewer", { path: configPath() }));
    expect(() => saveAppSettings({ theme: "light" })).toThrow(NewerFormatError);

    expect(fs.readFileSync(configPath(), "utf8")).toBe(body);
    expect(quarantined()).toEqual([]);
  });
});

// store-recovery-conventions: a failed quarantine rename propagates, so nothing resets over the bytes.
it("stops with a message naming an unreadable file it could not move aside, and leaves it in place", () => {
  fs.writeFileSync(configPath(), "{ theme");
  const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
    throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
  });
  try {
    expect(() => initAppSettingsStore()).toThrow(QuarantineError);
    expect(carriedMessage(captured(() => initAppSettingsStore()))).toEqual(
      message("store.quarantineFailed", { path: configPath() }),
    );
  } finally {
    rename.mockRestore();
  }
  expect(fs.readFileSync(configPath(), "utf-8")).toBe("{ theme");
  expect(quarantined()).toEqual([]);
});

function captured(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return null;
}
