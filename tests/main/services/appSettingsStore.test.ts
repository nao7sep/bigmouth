// The storage root's config.json holds the app-wide settings (the theme). These
// tests cover sparse writes, and stopping on a file that cannot be used.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as logger from "@main/core/services/logger.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getAppRoot } from "@main/core/services/storagePaths.js";
import { NewerFormatError, UnreadableStoreError } from "@main/core/shared/storeFormat.js";
import { carriedMessage } from "@shared/i18n/carriedMessage";
import { message } from "@shared/i18n/translate";
import {
  getAppSettingsLoad,
  initAppSettingsStore,
  saveAppSettings,
} from "@main/core/services/appSettingsStore.js";
import { fileHeader, newerHeader } from "../fileHeader.js";

const SAVED_DATA_DIR = process.env.BIGMOUTH_DATA_DIR;
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
  if (SAVED_DATA_DIR === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_DATA_DIR;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("appSettingsStore", () => {
  it("stops, naming a file it could not read, and leaves it in place", () => {
    // A directory where the file should be fails the read itself, as a permission error does.
    fs.mkdirSync(configPath());
    expect(carriedMessage(captured(() => initAppSettingsStore()))).toEqual(message("store.unreadable", { path: configPath() }));
    expect(fs.statSync(configPath()).isDirectory()).toBe(true);
    expect(quarantined()).toEqual([]);
  });

  it("keeps defaults in memory on first launch", () => {
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(fs.existsSync(configPath())).toBe(false);
    expect(getAppSettingsLoad()).toEqual({ settings: { theme: "system", language: "system" }, notices: [] });
  });

  it("reads a saved theme back without rewriting the file", () => {
    fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), theme: "dark" }));
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "system" });
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(JSON.stringify({ ...fileHeader("appConfig"), theme: "dark" }));
  });

  it("follows the OS for an unrecognized theme name without treating it as corruption", () => {
    fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), theme: "sepia" }));
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(quarantined()).toEqual([]);
  });

  it.each([
    ["invalid JSON", "{ theme"],
    ["a non-object", "[]"],
    ["no header", JSON.stringify({ theme: "dark" })],
    ["another kind", JSON.stringify({ ...fileHeader("workspaceConfig"), theme: "dark" })],
  ])("stops on %s, naming the file, and leaves it byte-identical", (_label, body) => {
    fs.writeFileSync(configPath(), body);
    expect(() => initAppSettingsStore()).toThrow(UnreadableStoreError);
    expect(carriedMessage(captured(() => initAppSettingsStore()))).toEqual(message("store.unreadable", { path: configPath() }));
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(body);
    expect(quarantined()).toEqual([]);
  });

  it("reads a saved language back, and follows the computer for an unknown one", () => {
    fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), theme: "dark", language: "ko" }));
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "ko" });
    fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), language: "tlh" }));
    expect(initAppSettingsStore()).toEqual({ theme: "system", language: "system" });
    expect(quarantined()).toEqual([]);
  });

  it("saves only known keys", () => {
    initAppSettingsStore();
    expect(saveAppSettings({ theme: "light", extra: 1 } as never)).toEqual({ theme: "light", language: "system" });
    expect(JSON.parse(fs.readFileSync(configPath(), "utf-8"))).toEqual({ ...fileHeader("appConfig"), theme: "light" });
  });
});

it("ignores invalid set shapes without quarantining valid neighbours", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), theme: true, language: "ja" }));
  expect(initAppSettingsStore()).toEqual({ theme: "system", language: "ja" });
  expect(quarantined()).toEqual([]);
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ ...fileHeader("appConfig"), theme: true, language: "ja" });
});

it("changing one set keeps another known copy and a key this build does not know", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), laterSet: 1, theme: "dark" }));
  initAppSettingsStore();
  saveAppSettings({ theme: "dark", language: "ja" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ ...fileHeader("appConfig"), theme: "dark", language: "ja", laterSet: 1 });
});

it("a save removes each set equal to its built-in and keeps the file", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), theme: "dark", language: "ja" }));
  initAppSettingsStore();
  saveAppSettings({ theme: "system", language: "ja" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ ...fileHeader("appConfig"), language: "ja" });
  saveAppSettings({ theme: "system", language: "system" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual(fileHeader("appConfig"));
});

it("an invalid set is kept as stored until the user changes it", () => {
  fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), theme: true, language: "ja" }));
  initAppSettingsStore();
  saveAppSettings({ theme: "system", language: "en" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ ...fileHeader("appConfig"), language: "en", theme: true });
  saveAppSettings({ theme: "dark", language: "en" });
  expect(JSON.parse(fs.readFileSync(configPath(), "utf8"))).toEqual({ ...fileHeader("appConfig"), theme: "dark", language: "en" });
});

it("saving built-ins on a fresh install creates no file", () => {
  initAppSettingsStore();
  saveAppSettings({ theme: "system", language: "system" });
  expect(fs.existsSync(configPath())).toBe(false);
});

it("warns on each load of an invalid app set and names its key", () => {
  const warning = vi.spyOn(logger, "warn");
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ ...fileHeader("appConfig"), theme: "sepia" }));
    initAppSettingsStore();
    initAppSettingsStore();
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: "theme" }));
  } finally { warning.mockRestore(); }
});

describe("appSettingsStore header", () => {


  it("writes this build's header and reads it back", () => {
    initAppSettingsStore();
    saveAppSettings({ theme: "dark", language: "system" });
    expect(fs.readFileSync(configPath(), "utf8")).toBe(JSON.stringify({ ...fileHeader("appConfig"), theme: "dark" }, null, 2) + "\n");
    expect(initAppSettingsStore()).toEqual({ theme: "dark", language: "system" });
  });

  it("stops on a file a newer version wrote, naming it, and leaves it byte-identical", () => {
    const body = JSON.stringify({ ...newerHeader("appConfig", 2), theme: "dark", future: true });
    fs.writeFileSync(configPath(), body);

    expect(() => initAppSettingsStore()).toThrow(NewerFormatError);
    expect(carriedMessage(captured(() => initAppSettingsStore()))).toEqual(message("store.newerFormat", { path: configPath() }));
    expect(fs.readFileSync(configPath(), "utf8")).toBe(body);
    expect(quarantined()).toEqual([]);
  });
});


function captured(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return null;
}
