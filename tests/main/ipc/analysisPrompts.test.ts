// Integration test for the analysis-prompt IPC handlers: the real configStore
// runs against a throwaway BIGMOUTH_HOME + a real registered workspace; only
// `electron` (ipcMain) and the logger are mocked. Exercises the registrar,
// argument validation, the defaults channel, and a re-read round-trip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { AnalysisPrompt } from "@shared/types";

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
import { DEFAULT_ANALYSIS_PROMPTS } from "@main/core/shared/defaults.js";
import { registerAnalysisPromptHandlers } from "@main/ipc/analysisPrompts.js";

let home: string;
let wsId: string;
const SAVED_HOME = process.env.BIGMOUTH_HOME;

function invoke<T>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-analysis-"));
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
  handlers.clear();
  registerAnalysisPromptHandlers();
  wsId = createWorkspace("WS").id;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("analysis-prompt IPC handlers", () => {
  it("returns the built-in defaults independent of any workspace", () => {
    const defaults = invoke<AnalysisPrompt[]>(CHANNELS.listAnalysisPromptDefaults);
    expect(defaults).toEqual(DEFAULT_ANALYSIS_PROMPTS);
  });

  it("lists the seeded default prompts for a fresh workspace", () => {
    const prompts = invoke<AnalysisPrompt[]>(CHANNELS.listAnalysisPrompts, wsId);
    expect(prompts.map((p) => p.name)).toEqual(DEFAULT_ANALYSIS_PROMPTS.map((p) => p.name));
  });

  it("saves prompts through the store and round-trips them", () => {
    const next: AnalysisPrompt[] = [
      { name: "Tone", text: "Check the tone of {content}" },
      { name: "Empty body allowed", text: "" },
    ];
    const saved = invoke<AnalysisPrompt[]>(CHANNELS.saveAnalysisPrompts, wsId, next);
    expect(saved).toEqual(next);
    expect(invoke<AnalysisPrompt[]>(CHANNELS.listAnalysisPrompts, wsId)).toEqual(next);
  });

  it("normalizes each saved prompt to only name + text", () => {
    const saved = invoke<AnalysisPrompt[]>(CHANNELS.saveAnalysisPrompts, wsId, [
      { name: "P", text: "t", stray: 1 } as unknown as AnalysisPrompt,
    ]);
    expect(saved[0]).toEqual({ name: "P", text: "t" });
    expect(saved[0]).not.toHaveProperty("stray");
  });

  it("validates the save payload before reaching the store", () => {
    expect(() => invoke(CHANNELS.saveAnalysisPrompts, wsId, "nope")).toThrow(/must be an array/);
    expect(() => invoke(CHANNELS.saveAnalysisPrompts, wsId, [null])).toThrow(/must be an object/);
    expect(() => invoke(CHANNELS.saveAnalysisPrompts, wsId, [{ name: "", text: "t" }])).toThrow(/non-empty name/);
    expect(() =>
      invoke(CHANNELS.saveAnalysisPrompts, wsId, [{ name: "P", text: 5 } as unknown as AnalysisPrompt]),
    ).toThrow(/text string/);
  });

  it("surfaces an unknown workspace as a thrown Error", () => {
    expect(() => invoke(CHANNELS.listAnalysisPrompts, "nope")).toThrow(/Workspace not found/);
    expect(() => invoke(CHANNELS.saveAnalysisPrompts, "nope", [{ name: "P", text: "t" }])).toThrow(
      /Workspace not found/,
    );
  });
});
