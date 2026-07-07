// Integration test for the AI-config IPC handlers: the real services run against
// a throwaway BIGMOUTH_HOME + a real registered workspace; only `electron`
// (ipcMain) and the logger are mocked. Exercises the registrar, argument
// validation, and the error mapping each handler wraps around the store.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { AiConfigsData } from "@shared/types";

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

import { initAppDir, createWorkspace, getApiKeysPath } from "@main/core/services/workspaceStore.js";
import { registerAiConfigHandlers } from "@main/ipc/aiConfigs.js";

let home: string;
let wsId: string;
const SAVED_HOME = process.env.BIGMOUTH_HOME;
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

function invoke<T = AiConfigsData>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-aicfg-"));
  process.env.BIGMOUTH_HOME = home;
  delete process.env.ANTHROPIC_API_KEY;
  initAppDir();
  handlers.clear();
  registerAiConfigHandlers();
  wsId = createWorkspace("WS").id;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("aiConfig IPC handlers", () => {
  it("lists the default config for a fresh workspace", () => {
    const data = invoke(CHANNELS.listAiConfigs, wsId);
    expect(data.configs).toHaveLength(1);
    expect(data.activeId).toBe(data.configs[0].id);
  });

  it("creates a config and routes the key to the secrets file, not the workspace", () => {
    invoke(CHANNELS.createAiConfig, wsId, {
      id: "c1",
      name: "Claude",
      provider: "anthropic",
      model: "m",
      apiKey: "sk-secret",
    });
    const view = invoke(CHANNELS.listAiConfigs, wsId).configs.find((c) => c.id === "c1");
    expect(view?.hasApiKey).toBe(true);
    expect(view?.apiKey).toBe(""); // key never crosses the bridge
    expect(fs.readFileSync(getApiKeysPath(), "utf-8")).not.toContain("sk-secret"); // obfuscated
  });

  it("validates create input", () => {
    expect(() => invoke(CHANNELS.createAiConfig, wsId, { id: "bad id!", name: "n", provider: "anthropic", model: "m" }))
      .toThrow(/id is required/);
    expect(() => invoke(CHANNELS.createAiConfig, wsId, { id: "c1", name: "n", provider: "nope", model: "m" }))
      .toThrow(/provider must be one of/);
  });

  it("updates, sets-active, and deletes through the store", () => {
    invoke(CHANNELS.createAiConfig, wsId, { id: "c1", name: "A", provider: "anthropic", model: "m" });
    invoke(CHANNELS.createAiConfig, wsId, { id: "c2", name: "B", provider: "anthropic", model: "m" });

    const updated = invoke(CHANNELS.updateAiConfig, wsId, "c1", { name: "Renamed" });
    expect(updated.configs.find((c) => c.id === "c1")?.name).toBe("Renamed");

    invoke(CHANNELS.setActiveAiConfig, wsId, "c2");
    expect(invoke(CHANNELS.listAiConfigs, wsId).activeId).toBe("c2");

    const afterDelete = invoke(CHANNELS.deleteAiConfig, wsId, "c1");
    expect(afterDelete.configs.map((c) => c.id)).not.toContain("c1");
  });

  it("maps store errors (deleting a missing config) to a thrown Error", () => {
    expect(() => invoke(CHANNELS.deleteAiConfig, wsId, "ghost")).toThrow(/not found/i);
  });

  it("rejects a malformed id before reaching the store", () => {
    expect(() => invoke(CHANNELS.updateAiConfig, wsId, "bad id!", { name: "x" })).toThrow(/malformed/);
    expect(() => invoke(CHANNELS.deleteAiConfig, wsId, "bad id!")).toThrow(/malformed/);
  });
});
