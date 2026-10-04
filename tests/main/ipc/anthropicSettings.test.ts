// Integration test for the Anthropic section's IPC handlers: the real configStore
// and key store run against a throwaway BIGMOUTH_DATA_DIR and a real registered
// workspace; only `electron` (ipcMain) and the logger are mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS } from "@shared/ipc";
import type { AnthropicSettingsView } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

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
import { getApiKeysPath } from "@main/core/services/storagePaths.js";
import { registerAnthropicSettingsHandlers } from "@main/ipc/anthropicSettings.js";

let home: string;
let wsId: string;
let dataDir: string;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

function invoke(channel: string, ...args: unknown[]): AnthropicSettingsView {
  return handlers.get(channel)!({}, ...args) as AnthropicSettingsView;
}

function section(over: Record<string, unknown> = {}) {
  return {
    endpoint: "https://api.anthropic.com",
    models: { analysis: "claude-opus-5-5", metadata: "claude-haiku-4-5", imagingPrompts: "claude-sonnet-5-5" },
    thinking: { analysis: "high", metadata: "off", imagingPrompts: "adaptive" },
    ...over,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-anthropic-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  delete process.env.ANTHROPIC_API_KEY;
  initAppDir();
  handlers.clear();
  registerAnthropicSettingsHandlers();
  const ws = createWorkspace("WS");
  wsId = ws.id;
  dataDir = ws.dataDirectory;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("Anthropic section IPC", () => {
  it("saves the section and its key, and answers with the section, never the key", () => {
    const view = invoke(CHANNELS.saveAnthropicSettings, wsId, section({ apiKey: "sk-ant-secret" }));
    expect(view).toEqual({ ...section(), hasApiKey: true, usingEnvKey: false });
    expect(JSON.stringify(view)).not.toContain("sk-ant-secret");
    expect(invoke(CHANNELS.getAnthropicSettings, wsId)).toEqual(view);
    expect(fs.readFileSync(getApiKeysPath(), "utf8")).not.toContain("sk-ant-secret");
    expect(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).not.toContain("sk-ant");
  });

  it.each([
    ["no models", { models: undefined }, /endpoint, models and thinking/],
    ["an endpoint that is not an http(s) URL", { endpoint: "file:///etc" }, /http or https URL/],
    ["an empty model", { models: { analysis: "", metadata: "m", imagingPrompts: "i" } }, /must name a model/],
    ["a thinking value that is not a string", { thinking: { analysis: 1, metadata: "off", imagingPrompts: "adaptive" } }, /must be a string/],
    ["a key that is not a string", { apiKey: 42 }, /apiKey must be a string/],
  ])("rejects %s and writes nothing", (_case, over, error) => {
    expect(() => invoke(CHANNELS.saveAnthropicSettings, wsId, section(over))).toThrow(error);
    expect(fs.existsSync(path.join(dataDir, "config.json"))).toBe(false);
    expect(fs.existsSync(getApiKeysPath())).toBe(false);
  });

  it("rejects an unknown workspace", () => {
    expect(() => invoke(CHANNELS.getAnthropicSettings, "no-such-ws")).toThrow();
  });
});
