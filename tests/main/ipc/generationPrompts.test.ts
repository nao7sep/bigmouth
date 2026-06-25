// Integration test for the generation-prompt IPC handlers: the real configStore
// runs against a throwaway BIGMOUTH_HOME + a real registered workspace; only
// `electron` (ipcMain) and the logger are mocked. Exercises the registrar,
// argument validation, the defaults channel, and the key-filtering round-trip.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { GenerationPromptsData } from "@shared/types";

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
import { DEFAULT_GENERATION_PROMPTS_DATA } from "@main/core/shared/defaults.js";
import { GENERATION_PROMPT_KEYS } from "@main/core/ai/generationPrompts.js";
import { registerGenerationPromptHandlers } from "@main/ipc/generationPrompts.js";

let home: string;
let wsId: string;
const SAVED_HOME = process.env.BIGMOUTH_HOME;

function invoke<T>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-generation-"));
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
  handlers.clear();
  registerGenerationPromptHandlers();
  wsId = createWorkspace("WS").id;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("generation-prompt IPC handlers", () => {
  it("returns the built-in defaults independent of any workspace", () => {
    const defaults = invoke<GenerationPromptsData>(CHANNELS.getGenerationPromptDefaults);
    expect(defaults).toEqual(DEFAULT_GENERATION_PROMPTS_DATA);
  });

  it("returns the seeded prompts for a fresh workspace", () => {
    const prompts = invoke<GenerationPromptsData>(CHANNELS.getGenerationPrompts, wsId);
    expect(prompts).toEqual(DEFAULT_GENERATION_PROMPTS_DATA);
  });

  it("saves prompts through the store and round-trips them", () => {
    const next: GenerationPromptsData = { prompts: { title: "Custom title prompt", slug: "Custom slug prompt" } };
    const saved = invoke<GenerationPromptsData>(CHANNELS.saveGenerationPrompts, wsId, next);
    expect(saved.prompts.title).toBe("Custom title prompt");
    expect(saved.prompts.slug).toBe("Custom slug prompt");
    expect(invoke<GenerationPromptsData>(CHANNELS.getGenerationPrompts, wsId)).toEqual(saved);
  });

  it("drops unknown prompt keys on save (only known keys persist)", () => {
    const saved = invoke<GenerationPromptsData>(CHANNELS.saveGenerationPrompts, wsId, {
      prompts: { title: "kept", bogus: "dropped" },
    } as unknown as GenerationPromptsData);
    expect(saved.prompts.title).toBe("kept");
    expect(saved.prompts).not.toHaveProperty("bogus");
    for (const key of Object.keys(saved.prompts)) {
      expect(GENERATION_PROMPT_KEYS as readonly string[]).toContain(key);
    }
  });

  it("validates the save payload before reaching the store", () => {
    expect(() => invoke(CHANNELS.saveGenerationPrompts, wsId, null)).toThrow(/prompts must be an object/);
    expect(() => invoke(CHANNELS.saveGenerationPrompts, wsId, {})).toThrow(/prompts must be an object/);
    expect(() => invoke(CHANNELS.saveGenerationPrompts, wsId, { prompts: [] })).toThrow(/prompts must be an object/);
    expect(() => invoke(CHANNELS.saveGenerationPrompts, wsId, { prompts: "x" })).toThrow(/prompts must be an object/);
    expect(() => invoke(CHANNELS.saveGenerationPrompts, wsId, { prompts: { title: 5 } })).toThrow(
      /every prompt value must be a string/,
    );
  });

  it("surfaces an unknown workspace as a thrown Error", () => {
    expect(() => invoke(CHANNELS.getGenerationPrompts, "nope")).toThrow(/Workspace not found/);
    expect(() => invoke(CHANNELS.saveGenerationPrompts, "nope", { prompts: { title: "t" } })).toThrow(
      /Workspace not found/,
    );
  });
});
