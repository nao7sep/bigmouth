// Integration test for the settings IPC handlers: the real configStore runs
// against a throwaway BIGMOUTH_DATA_DIR + a real registered workspace; the async storageAccess edge calls these real services while Electron
// and the logger are mocked. Exercises the registrar, argument
// validation, and the error each handler surfaces from the store.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { Settings } from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("@main/storageAccess.js", async () => {
  const workspaceStore = await import("@main/core/services/workspaceStore.js");
  const configStore = await import("@main/core/services/configStore.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspaceStore.getWorkspace>) => workspaceStore.getWorkspace(...args),
    getSettings: async (...args: Parameters<typeof configStore.getSettings>) => configStore.getSettings(...args),
    saveSettings: async (...args: Parameters<typeof configStore.saveSettings>) => configStore.saveSettings(...args),
  };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { registerSettingsHandlers } from "@main/ipc/settings.js";

let home: string;
let wsId: string;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;

function invoke<T = Settings>(channel: string, ...args: unknown[]): Promise<T> {
  return handlers.get(channel)!({}, ...args) as Promise<T>;
}

function validSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    timezone: "America/New_York",
    supportedLanguages: ["en", "ja"],
    postsPerLoad: 25,
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
  process.env.BIGMOUTH_DATA_DIR = home;
  initAppDir();
  handlers.clear();
  registerSettingsHandlers();
  wsId = createWorkspace("WS").id;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("settings IPC handlers", () => {
  it("returns the default settings for a fresh workspace", async () => {
    const settings = (await invoke(CHANNELS.getSettings, wsId));
    expect(settings.timezone).toBe("system");
    expect(Array.isArray(settings.supportedLanguages)).toBe(true);
    expect(settings.postsPerLoad).toBe(50);
  });

  it("saves settings through the store and round-trips them", async () => {
    const saved = (await invoke(CHANNELS.saveSettings, wsId, validSettings({ timezone: "Europe/Berlin" })));
    expect(saved.timezone).toBe("Europe/Berlin");
    // The store normalizes (dedupes + sorts) supportedLanguages; a re-read must
    // return what was persisted.
    expect((await invoke(CHANNELS.getSettings, wsId)).timezone).toBe("Europe/Berlin");
  });

  it("normalizes supportedLanguages on save (dedupe + sort)", async () => {
    const saved = (await invoke(CHANNELS.saveSettings, wsId, validSettings({ supportedLanguages: ["ja", "en", "ja"] })));
    expect(saved.supportedLanguages).toEqual(["en", "ja"]);
  });

  it("validates each settings field before reaching the store", async () => {
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ timezone: "" }))).rejects.toThrow(/timezone/);
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ supportedLanguages: [1] as unknown as string[] }))).rejects.toThrow(/supportedLanguages/);
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ postsPerLoad: 0 }))).rejects.toThrow(/postsPerLoad/);
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ postsPerLoad: 2.5 }))).rejects.toThrow(/postsPerLoad/);
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ maxUploadMb: 0 }))).rejects.toThrow(/maxUploadMb/);
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ editorWatermark: 5 as unknown as string }))).rejects.toThrow(/editorWatermark/);
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ extraFieldWatermark: 5 as unknown as string }))).rejects.toThrow(/extraFieldWatermark/);
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ uiFontFamily: 5 as unknown as string }))).rejects.toThrow(/uiFontFamily/);
  });

  it("validates the content font: type, ranges, and toggles", async () => {
    const withFont = (over: Partial<Settings["contentFont"]>) =>
      validSettings({ contentFont: { ...DEFAULT_CONTENT_FONT, ...over } });
    await expect(invoke(CHANNELS.saveSettings, wsId, validSettings({ contentFont: null as unknown as Settings["contentFont"] }))).rejects.toThrow(/contentFont/);
    await expect(invoke(CHANNELS.saveSettings, wsId, withFont({ family: 5 as unknown as string }))).rejects.toThrow(/contentFont\.family/);
    await expect(invoke(CHANNELS.saveSettings, wsId, withFont({ size: 4 }))).rejects.toThrow(/contentFont\.size/);
    await expect(invoke(CHANNELS.saveSettings, wsId, withFont({ size: 99 }))).rejects.toThrow(/contentFont\.size/);
    await expect(invoke(CHANNELS.saveSettings, wsId, withFont({ lineHeight: 0.5 }))).rejects.toThrow(/contentFont\.lineHeight/);
    await expect(invoke(CHANNELS.saveSettings, wsId, withFont({ padding: -1 }))).rejects.toThrow(/contentFont\.padding/);
    await expect(invoke(CHANNELS.saveSettings, wsId, withFont({ padding: 999 }))).rejects.toThrow(/contentFont\.padding/);
    await expect(invoke(CHANNELS.saveSettings, wsId, withFont({ bold: "yes" as unknown as boolean }))).rejects.toThrow(/contentFont\.bold/);
    // A valid, fully-specified content font round-trips.
    const saved = (await invoke(CHANNELS.saveSettings, wsId, withFont({ family: "Iosevka", size: 18, lineHeight: 1.8, padding: 24, bold: true })));
    expect(saved.contentFont).toEqual({ family: "Iosevka", size: 18, lineHeight: 1.8, padding: 24, bold: true, italic: false, underline: false });
    expect((await invoke(CHANNELS.getSettings, wsId)).contentFont.size).toBe(18);
  });

  it("surfaces an unknown workspace as a thrown Error", async () => {
    await expect(invoke(CHANNELS.getSettings, "nope")).rejects.toThrow(/Workspace not found/);
    await expect(invoke(CHANNELS.saveSettings, "nope", validSettings())).rejects.toThrow(/Workspace not found/);
  });
});
