// Integration test for the settings IPC handlers: the real configStore runs
// against a throwaway BIGMOUTH_HOME + a real registered workspace; only `electron`
// (ipcMain) and the logger are mocked. Exercises the registrar, argument
// validation, and the error each handler surfaces from the store.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { Settings } from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { registerSettingsHandlers } from "@main/ipc/settings.js";

let home: string;
let wsId: string;
const SAVED_HOME = process.env.BIGMOUTH_HOME;

function invoke<T = Settings>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

function validSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    timezone: "America/New_York",
    supportedLanguages: ["en", "ja"],
    publishedPostsPerLoad: 25,
    maxUploadMb: 100,
    editorWatermark: "write here",
    extraFieldWatermark: "extra",
    uiFontFamily: "",
    contentFont: DEFAULT_CONTENT_FONT,
    ...overrides,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-settings-"));
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
  handlers.clear();
  registerSettingsHandlers();
  wsId = createWorkspace("WS").id;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("settings IPC handlers", () => {
  it("returns the default settings for a fresh workspace", () => {
    const settings = invoke(CHANNELS.getSettings, wsId);
    expect(settings.timezone).toBe("Asia/Tokyo");
    expect(Array.isArray(settings.supportedLanguages)).toBe(true);
    expect(settings.publishedPostsPerLoad).toBe(50);
  });

  it("saves settings through the store and round-trips them", () => {
    const saved = invoke(CHANNELS.saveSettings, wsId, validSettings({ timezone: "Europe/Berlin" }));
    expect(saved.timezone).toBe("Europe/Berlin");
    // The store normalizes (dedupes + sorts) supportedLanguages; a re-read must
    // return what was persisted.
    expect(invoke(CHANNELS.getSettings, wsId).timezone).toBe("Europe/Berlin");
  });

  it("normalizes supportedLanguages on save (dedupe + sort)", () => {
    const saved = invoke(CHANNELS.saveSettings, wsId, validSettings({ supportedLanguages: ["ja", "en", "ja"] }));
    expect(saved.supportedLanguages).toEqual(["en", "ja"]);
  });

  it("validates each settings field before reaching the store", () => {
    expect(() => invoke(CHANNELS.saveSettings, wsId, validSettings({ timezone: "" }))).toThrow(/timezone/);
    expect(() =>
      invoke(CHANNELS.saveSettings, wsId, validSettings({ supportedLanguages: [1] as unknown as string[] })),
    ).toThrow(/supportedLanguages/);
    expect(() => invoke(CHANNELS.saveSettings, wsId, validSettings({ publishedPostsPerLoad: 0 }))).toThrow(
      /publishedPostsPerLoad/,
    );
    expect(() => invoke(CHANNELS.saveSettings, wsId, validSettings({ publishedPostsPerLoad: 2.5 }))).toThrow(
      /publishedPostsPerLoad/,
    );
    expect(() => invoke(CHANNELS.saveSettings, wsId, validSettings({ maxUploadMb: 0 }))).toThrow(/maxUploadMb/);
    expect(() =>
      invoke(CHANNELS.saveSettings, wsId, validSettings({ editorWatermark: 5 as unknown as string })),
    ).toThrow(/editorWatermark/);
    expect(() =>
      invoke(CHANNELS.saveSettings, wsId, validSettings({ extraFieldWatermark: 5 as unknown as string })),
    ).toThrow(/extraFieldWatermark/);
    expect(() =>
      invoke(CHANNELS.saveSettings, wsId, validSettings({ uiFontFamily: 5 as unknown as string })),
    ).toThrow(/uiFontFamily/);
  });

  it("validates the content font: type, ranges, and toggles", () => {
    const withFont = (over: Partial<Settings["contentFont"]>) =>
      validSettings({ contentFont: { ...DEFAULT_CONTENT_FONT, ...over } });
    expect(() => invoke(CHANNELS.saveSettings, wsId, validSettings({ contentFont: null as unknown as Settings["contentFont"] }))).toThrow(/contentFont/);
    expect(() => invoke(CHANNELS.saveSettings, wsId, withFont({ family: 5 as unknown as string }))).toThrow(/contentFont\.family/);
    expect(() => invoke(CHANNELS.saveSettings, wsId, withFont({ size: 4 }))).toThrow(/contentFont\.size/);
    expect(() => invoke(CHANNELS.saveSettings, wsId, withFont({ size: 99 }))).toThrow(/contentFont\.size/);
    expect(() => invoke(CHANNELS.saveSettings, wsId, withFont({ lineHeight: 0.5 }))).toThrow(/contentFont\.lineHeight/);
    expect(() => invoke(CHANNELS.saveSettings, wsId, withFont({ padding: -1 }))).toThrow(/contentFont\.padding/);
    expect(() => invoke(CHANNELS.saveSettings, wsId, withFont({ padding: 999 }))).toThrow(/contentFont\.padding/);
    expect(() => invoke(CHANNELS.saveSettings, wsId, withFont({ bold: "yes" as unknown as boolean }))).toThrow(/contentFont\.bold/);
    // A valid, fully-specified content font round-trips.
    const saved = invoke(CHANNELS.saveSettings, wsId, withFont({ family: "Iosevka", size: 18, lineHeight: 1.8, padding: 24, bold: true }));
    expect(saved.contentFont).toEqual({ family: "Iosevka", size: 18, lineHeight: 1.8, padding: 24, bold: true, italic: false, underline: false });
    expect(invoke(CHANNELS.getSettings, wsId).contentFont.size).toBe(18);
  });

  it("surfaces an unknown workspace as a thrown Error", () => {
    expect(() => invoke(CHANNELS.getSettings, "nope")).toThrow(/Workspace not found/);
    expect(() => invoke(CHANNELS.saveSettings, "nope", validSettings())).toThrow(/Workspace not found/);
  });
});
