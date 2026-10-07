// Integration test for the analysis-prompt IPC handlers: the real configStore
// runs against a throwaway BIGMOUTH_DATA_DIR + a real registered workspace; only
// `electron` (ipcMain) and the logger are mocked. Exercises the registrar,
// argument validation, the defaults channel, and a re-read round-trip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { AnalysisPrompt } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("@main/storageAccess.js", async () => {
  const workspaceStore = await import("@main/core/services/workspaceStore.js");
  const configStore = await import("@main/core/services/configStore.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspaceStore.getWorkspace>) => workspaceStore.getWorkspace(...args),
    getAnalysisPrompts: async (...args: Parameters<typeof configStore.getAnalysisPrompts>) => configStore.getAnalysisPrompts(...args),
    saveAnalysisPrompts: async (...args: Parameters<typeof configStore.saveAnalysisPrompts>) => configStore.saveAnalysisPrompts(...args),
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
import { DEFAULT_ANALYSIS_PROMPTS } from "@main/core/shared/defaults.js";
import { registerAnalysisPromptHandlers } from "@main/ipc/analysisPrompts.js";

let home: string;
let wsId: string;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return handlers.get(channel)!({}, ...args) as Promise<T>;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-analysis-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  initAppDir();
  handlers.clear();
  registerAnalysisPromptHandlers();
  wsId = createWorkspace("WS").id;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("analysis-prompt IPC handlers", () => {
  it("returns the built-in defaults independent of any workspace", async () => {
    const defaults = (await invoke<AnalysisPrompt[]>(CHANNELS.listAnalysisPromptDefaults));
    expect(defaults).toEqual(DEFAULT_ANALYSIS_PROMPTS);
  });

  it("lists the seeded default prompts for a fresh workspace", async () => {
    const prompts = (await invoke<AnalysisPrompt[]>(CHANNELS.listAnalysisPrompts, wsId));
    expect(prompts.map((p) => p.name)).toEqual(DEFAULT_ANALYSIS_PROMPTS.map((p) => p.name));
  });

  it("saves prompts through the store and round-trips them", async () => {
    const next: AnalysisPrompt[] = [
      { name: "Tone", text: "Check the tone of {content}" },
      { name: "Empty body allowed", text: "" },
    ];
    const saved = (await invoke<AnalysisPrompt[]>(CHANNELS.saveAnalysisPrompts, wsId, next));
    expect(saved).toEqual(next);
    expect((await invoke<AnalysisPrompt[]>(CHANNELS.listAnalysisPrompts, wsId))).toEqual(next);
  });

  it("normalizes each saved prompt to only name + text", async () => {
    const saved = (await invoke<AnalysisPrompt[]>(CHANNELS.saveAnalysisPrompts, wsId, [
      { name: "P", text: "t", stray: 1 } as unknown as AnalysisPrompt,
    ]));
    expect(saved[0]).toEqual({ name: "P", text: "t" });
    expect(saved[0]).not.toHaveProperty("stray");
  });

  it("validates the save payload before reaching the store", async () => {
    await expect(invoke(CHANNELS.saveAnalysisPrompts, wsId, "nope")).rejects.toThrow(/must be an array/);
    await expect(invoke(CHANNELS.saveAnalysisPrompts, wsId, [null])).rejects.toThrow(/must be an object/);
    await expect(invoke(CHANNELS.saveAnalysisPrompts, wsId, [{ name: "", text: "t" }])).rejects.toThrow(/non-empty name/);
    await expect(invoke(CHANNELS.saveAnalysisPrompts, wsId, [{ name: "P", text: 5 } as unknown as AnalysisPrompt])).rejects.toThrow(/text string/);
  });

  it("surfaces an unknown workspace as a thrown Error", async () => {
    await expect(invoke(CHANNELS.listAnalysisPrompts, "nope")).rejects.toThrow(/Workspace not found/);
    await expect(invoke(CHANNELS.saveAnalysisPrompts, "nope", [{ name: "P", text: "t" }])).rejects.toThrow(/Workspace not found/);
  });
});
