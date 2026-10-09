// Integration test for the generation-prompt IPC handlers: the real configStore
// runs against a throwaway BIGMOUTH_DATA_DIR + a real registered workspace; only
// `electron` (ipcMain) and the logger are mocked. Exercises the registrar,
// argument validation, the defaults channel, and whole-set round-trips.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { GenerationPromptsData } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("@main/storageAccess.js", async () => {
  const workspaceStore = await import("@main/core/services/workspaceStore.js");
  const configStore = await import("@main/core/services/configStore.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspaceStore.getWorkspace>) => workspaceStore.getWorkspace(...args),
    getGenerationPrompts: async (...args: Parameters<typeof configStore.getGenerationPrompts>) => configStore.getGenerationPrompts(...args),
    saveGenerationPrompts: async (...args: Parameters<typeof configStore.saveGenerationPrompts>) => configStore.saveGenerationPrompts(...args),
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
import { DEFAULT_GENERATION_PROMPTS_DATA } from "@main/core/shared/defaults.js";
import { registerGenerationPromptHandlers } from "@main/ipc/generationPrompts.js";

let home: string;
let wsId: string;
let wsDir: string;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return handlers.get(channel)!({}, ...args) as Promise<T>;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-generation-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  initAppDir();
  handlers.clear();
  registerGenerationPromptHandlers();
  ({ id: wsId, dataDirectory: wsDir } = createWorkspace("WS"));
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("generation-prompt IPC handlers", () => {
  it("returns the built-in defaults independent of any workspace", async () => {
    const defaults = (await invoke<GenerationPromptsData>(CHANNELS.getGenerationPromptDefaults));
    expect(defaults).toEqual(DEFAULT_GENERATION_PROMPTS_DATA);
  });

  it("returns the seeded prompts for a fresh workspace", async () => {
    const prompts = (await invoke<GenerationPromptsData>(CHANNELS.getGenerationPrompts, wsId));
    expect(prompts).toEqual(DEFAULT_GENERATION_PROMPTS_DATA);
  });

  it("saves prompts through the store and round-trips them", async () => {
    const next: GenerationPromptsData = { prompts: {
      ...DEFAULT_GENERATION_PROMPTS_DATA.prompts, title: "Custom title prompt", slug: "Custom slug prompt",
    } };
    const saved = (await invoke<GenerationPromptsData>(CHANNELS.saveGenerationPrompts, wsId, next));
    expect(saved.prompts.title).toBe("Custom title prompt");
    expect(saved.prompts.slug).toBe("Custom slug prompt");
    expect((await invoke<GenerationPromptsData>(CHANNELS.getGenerationPrompts, wsId))).toEqual(saved);
  });

  it("validates the save payload before reaching the store", async () => {
    const full = DEFAULT_GENERATION_PROMPTS_DATA.prompts;
    for (const body of [
      null,
      {},
      { prompts: [] },
      { prompts: "x" },
      { prompts: { ...full, title: 5 } },
    ]) {
      await expect(invoke(CHANNELS.saveGenerationPrompts, wsId, body)).rejects.toThrow(/prompts must map/);
    }
    expect(fs.existsSync(path.join(wsDir, "config.json"))).toBe(false);
  });

  it("reads a prompt a save left out as its built-in, and stores no prompt this build does not have", async () => {
    const full = DEFAULT_GENERATION_PROMPTS_DATA.prompts;
    const { title: _title, ...partial } = full;
    await invoke(CHANNELS.saveGenerationPrompts, wsId, { prompts: { ...partial, slug: "Custom", bogus: "unknown key" } });
    expect(await invoke(CHANNELS.getGenerationPrompts, wsId)).toEqual({ prompts: { ...full, slug: "Custom" } });
    expect(JSON.parse(fs.readFileSync(path.join(wsDir, "config.json"), "utf8")).generationPrompts).toEqual({ prompts: { slug: "Custom" } });
  });

  it("surfaces an unknown workspace as a thrown Error", async () => {
    await expect(invoke(CHANNELS.getGenerationPrompts, "nope")).rejects.toThrow(/Workspace not found/);
    await expect(invoke(CHANNELS.saveGenerationPrompts, "nope", { prompts: { title: "t" } })).rejects.toThrow(/Workspace not found/);
  });
});
