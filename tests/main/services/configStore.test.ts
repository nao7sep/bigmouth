import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as logger from "@main/core/services/logger.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "@shared/types";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getApiKeysPath } from "@main/core/services/storagePaths.js";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { DEFAULT_SETTINGS, makeDefaultConfig, defaultAnthropicSettings, DEFAULT_ANALYSIS_PROMPTS, DEFAULT_GENERATION_PROMPTS_DATA } from "@main/core/shared/defaults.js";
import {
  getSettings,
  getTargets,
  saveTargets,
  getAnalysisPrompts,
  saveAnalysisPrompts,
  getGenerationPrompts,
  saveGenerationPrompts,
  saveSettings,
  getAnthropicSettingsForClient,
  getRoleCall,
  saveAnthropicSettings,
} from "@main/core/services/configStore.js";
import type { AnthropicSettingsInput } from "@shared/types";

let dataDir: string;
let homeDir: string;
let ws: Workspace;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

// A workspace for an already-initialized data directory under the current home.
function workspaceAt(id: string, dir: string): Workspace {
  initializeWorkspaceData(dir);
  return { id, name: id, dataDirectory: dir };
}

beforeEach(() => {
  // A fresh storage root per test gives the secrets file (api-keys.json) a real,
  // isolated home; the AI-config tests rely on the stored key, so the env key is
  // cleared (it would otherwise win, env-first).
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-confighome-"));
  process.env.BIGMOUTH_DATA_DIR = homeDir;
  delete process.env.ANTHROPIC_API_KEY;
  initAppDir();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-configstore-"));
  ws = workspaceAt("ws-1", dataDir);
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("time zone", () => {
  function writeConfig(fields: Record<string, unknown>): void {
    const configPath = path.join(dataDir, "config.json");
    const current = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : {};
    fs.writeFileSync(configPath, JSON.stringify({ ...current, ...fields }), "utf-8");
  }

  it("defaults a new workspace to System", () => {
    expect(getSettings(dataDir).timezone).toBe("system");
  });

  it("keeps a stored timezone unchanged regardless of the retired version key", () => {
    writeConfig({ schemaVersion: 1, timezone: "Asia/Tokyo" });
    expect(getSettings(dataDir).timezone).toBe("Asia/Tokyo");

    saveSettings(dataDir, { ...getSettings(dataDir), uiFontFamily: "Inter" });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf-8"));
    expect(saved).toEqual({ timezone: "Asia/Tokyo", uiFontFamily: "Inter" });
  });

  it("keeps any other zone a version-1 file names, because the user typed it", () => {
    writeConfig({ schemaVersion: 1, timezone: "Europe/Berlin" });
    expect(getSettings(dataDir).timezone).toBe("Europe/Berlin");
  });

  it("keeps Asia/Tokyo once it was chosen from the list", () => {
    writeConfig({ schemaVersion: 2, timezone: "Asia/Tokyo" });
    expect(getSettings(dataDir).timezone).toBe("Asia/Tokyo");
  });

  it("follows the computer for a zone the runtime cannot resolve", () => {
    writeConfig({ timezone: "Mars/Olympus" });
    expect(getSettings(dataDir).timezone).toBe("system");
  });
});

describe("corrupt config files", () => {
  it("surfaces a clear error naming the file rather than a bare SyntaxError", () => {
    fs.writeFileSync(path.join(dataDir, "config.json"), "{ not valid json", "utf-8");
    expect(() => getSettings(dataDir)).toThrow(/config\.json is not valid JSON/);
  });

  it("uses the built-in for an invalid set without quarantining other sets", () => {
    const configPath = path.join(dataDir, "config.json");
    const healthy = makeDefaultConfig();
    const authoredTargets = [{ rowId: "r1", name: "blog", defaultLanguage: "en", requiresMetadata: false }];
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...healthy, targets: authoredTargets, analysisPrompts: "not an array" }),
      "utf-8",
    );

    expect(getAnalysisPrompts(dataDir)).toEqual(DEFAULT_ANALYSIS_PROMPTS);
    expect(getTargets(dataDir)).toEqual(authoredTargets);
    saveSettings(dataDir, { ...getSettings(dataDir), uiFontFamily: "Inter" });

    // The save writes what the store holds: the invalid set and every built-in copy lose their keys.
    const afterwards = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(afterwards).toEqual({ targets: authoredTargets, uiFontFamily: "Inter" });
  });

  it("ignores a retired version key and drops it at the next write", () => {
    const configPath = path.join(dataDir, "config.json");
    const healthy = makeDefaultConfig();
    fs.writeFileSync(configPath, JSON.stringify({ ...healthy, schemaVersion: 99 }), "utf-8");

    expect(getSettings(dataDir)).toEqual(DEFAULT_SETTINGS);
    saveTargets(dataDir, []);

    const afterwards = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(afterwards.schemaVersion).toBeUndefined();
  });

  it.each([
    ["an endpoint that is not an http(s) URL", { "anthropic.endpoint": "api.anthropic.com" }],
    ["an empty model", { "anthropic.analysis": "  " }],
    ["a model that is not a string", { "anthropic.metadata": 7 }],
  ])("reads %s as the built-in without rewriting", (_case, sets) => {
    const configPath = path.join(dataDir, "config.json");
    const stored = JSON.stringify(sets);
    fs.writeFileSync(configPath, stored, "utf8");

    const { endpoint, models, thinking } = getAnthropicSettingsForClient(ws);
    expect({ endpoint, models, thinking }).toEqual(defaultAnthropicSettings());
    expect(fs.readFileSync(configPath, "utf8")).toBe(stored);
  });
});

describe("settings", () => {
  it("normalizes supportedLanguages: de-duplicated and sorted", () => {
    const settings = getSettings(dataDir);
    saveSettings(dataDir, {
      ...settings,
      supportedLanguages: ["ja", "en", "ja", "es"],
    });
    expect(getSettings(dataDir).supportedLanguages).toEqual(["en", "es", "ja"]);
  });

  it("backfills fields absent from an older settings file with their defaults", () => {
    // A config.json written before uiFontFamily/contentFont existed: the read
    // must fill them from defaults rather than yield undefined (no migration code).
    fs.writeFileSync(
      path.join(dataDir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        timezone: "UTC",
        supportedLanguages: ["en"],
        publishedPostsPerLoad: 50,
        maxUploadMb: 500,
        editorWatermark: "",
        extraFieldWatermark: "",
        targets: [],
        analysisPrompts: [],
        generationPrompts: { prompts: {} },
      }),
      "utf-8",
    );
    const loaded = getSettings(dataDir);
    expect(loaded.uiFontFamily).toBe("");
    // The effective font uses the shared built-in.
    expect(loaded.contentFont).toEqual(DEFAULT_CONTENT_FONT);
  });

  it("round-trips the UI font and content font", () => {
    const settings = getSettings(dataDir);
    saveSettings(dataDir, {
      ...settings,
      uiFontFamily: "Inter, system-ui",
      contentFont: { family: "Iosevka", size: 18, lineHeight: 1.8, padding: 24, bold: true, italic: true, underline: false },
    });
    const reread = getSettings(dataDir);
    expect(reread.uiFontFamily).toBe("Inter, system-ui");
    expect(reread.contentFont).toEqual({ family: "Iosevka", size: 18, lineHeight: 1.8, padding: 24, bold: true, italic: true, underline: false });
  });
});

describe("the Anthropic section", () => {
  const file = () => path.join(dataDir, "config.json");
  const saved = () => JSON.parse(fs.readFileSync(file(), "utf8"));
  function input(over: Partial<AnthropicSettingsInput> = {}): AnthropicSettingsInput {
    return { ...defaultAnthropicSettings(), ...over };
  }

  it("reads the built-in section, each role at its default model and thinking", () => {
    expect(getAnthropicSettingsForClient(ws)).toEqual({
      endpoint: "https://api.anthropic.com",
      models: { analysis: "claude-sonnet-5-5", metadata: "claude-haiku-4-5", imagingPrompts: "claude-sonnet-5-5" },
      thinking: { analysis: "adaptive", metadata: "off", imagingPrompts: "adaptive" },
      hasApiKey: false,
      usingEnvKey: false,
    });
    expect(getRoleCall(ws, "metadata")).toEqual({
      endpoint: "https://api.anthropic.com",
      model: "claude-haiku-4-5",
      thinking: "off",
      apiKey: null,
    });
  });

  it("keeps the key out of the workspace file and in the storage-root secrets file, under the provider id", () => {
    saveAnthropicSettings(ws, input({ apiKey: "sk-ant-secret" }));

    expect(fs.existsSync(file())).toBe(false);
    const secrets = fs.readFileSync(getApiKeysPath(), "utf-8");
    expect(secrets).not.toContain("sk-ant-secret");
    expect(Object.keys(JSON.parse(secrets).workspaces["ws-1"].keys)).toEqual(["anthropic"]);
    expect(getAnthropicSettingsForClient(ws).hasApiKey).toBe(true);
    for (const role of ["analysis", "metadata", "imagingPrompts"] as const) {
      expect(getRoleCall(ws, role).apiKey).toBe("sk-ant-secret");
    }
  });

  it("keeps the stored key when Save sends none or a blank one", () => {
    saveAnthropicSettings(ws, input({ apiKey: "sk-ant-secret" }));
    saveAnthropicSettings(ws, input());
    saveAnthropicSettings(ws, input({ apiKey: "   " }));
    expect(getRoleCall(ws, "analysis").apiKey).toBe("sk-ant-secret");
  });

  it("keeps keys independent for two workspaces", () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-configstore2-"));
    try {
      const ws2 = workspaceAt("ws-2", dir2);
      saveAnthropicSettings(ws, input({ apiKey: "key-ws1" }));
      saveAnthropicSettings(ws2, input({ apiKey: "key-ws2" }));
      expect(getRoleCall(ws, "analysis").apiKey).toBe("key-ws1");
      expect(getRoleCall(ws2, "analysis").apiKey).toBe("key-ws2");
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("hasApiKey is stored-only while usingEnvKey reflects the environment, and resolution is env-first", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    const view = getAnthropicSettingsForClient(ws);
    expect(view.hasApiKey).toBe(false);
    expect(view.usingEnvKey).toBe(true);
    saveAnthropicSettings(ws, input({ apiKey: "stored" }));
    expect(getRoleCall(ws, "analysis").apiKey).toBe("sk-ant-from-env");
  });

  it("stores each set only while it differs from its built-in, a model compared trimmed and case-insensitively", () => {
    const defaults = defaultAnthropicSettings();
    saveAnthropicSettings(ws, input({
      endpoint: " https://proxy.example/anthropic ",
      models: { ...defaults.models, analysis: "claude-opus-5-5", metadata: " Claude-Haiku-4-5 " },
      thinking: { ...defaults.thinking, analysis: "max" },
    }));
    expect(saved()).toEqual({
      "anthropic.endpoint": "https://proxy.example/anthropic",
      "anthropic.analysis": "claude-opus-5-5",
      "anthropic.thinking.analysis": "max",
    });
    expect(getRoleCall(ws, "analysis")).toMatchObject({ model: "claude-opus-5-5", thinking: "max" });

    saveAnthropicSettings(ws, input());
    expect(saved()).toEqual({});
  });

  it("stores a role's thinking only while it differs from its model's default", () => {
    const defaults = defaultAnthropicSettings();
    // Opus defaults to adaptive: a new model with its default thinking stores only the model.
    saveAnthropicSettings(ws, input({ models: { ...defaults.models, imagingPrompts: "claude-opus-5-5" } }));
    expect(saved()).toEqual({ "anthropic.imagingPrompts": "claude-opus-5-5" });
    saveAnthropicSettings(ws, input({ thinking: { ...defaults.thinking, analysis: "between_tools" } }));
    expect(saved()).toEqual({ "anthropic.thinking.analysis": "between_tools" });
    expect(getRoleCall(ws, "analysis").thinking).toBe("between_tools");
  });

  it("sends no thinking for a model with no row, and the role's default for a value its row does not list", () => {
    const defaults = defaultAnthropicSettings();
    saveAnthropicSettings(ws, input({
      models: { ...defaults.models, analysis: "claude-next-9" },
      thinking: { ...defaults.thinking, analysis: "between_tools" },
    }));
    expect(getRoleCall(ws, "analysis")).toMatchObject({ model: "claude-next-9", thinking: undefined });
    // A model with no row sends no thinking, so its role's thinking is never stored.
    expect(saved()).toEqual({ "anthropic.analysis": "claude-next-9" });

    fs.writeFileSync(file(), JSON.stringify({ "anthropic.analysis": "claude-opus-5-5", "anthropic.thinking.analysis": "between_tools" }));
    expect(getRoleCall(ws, "analysis").thinking).toBe("adaptive");
    expect(getAnthropicSettingsForClient(ws).thinking.analysis).toBe("adaptive");
  });
});

describe("settings stored by set", () => {
  const file = () => path.join(dataDir, "config.json");
  const saved = () => JSON.parse(fs.readFileSync(file(), "utf8"));

  it("reads all built-ins without seeding a file", () => {
    expect(getSettings(dataDir)).toEqual(DEFAULT_SETTINGS);
    expect(getTargets(dataDir)).toEqual([]);
    expect(getRoleCall(ws, "analysis").model).toBe("claude-sonnet-5-5");
    expect(getAnalysisPrompts(dataDir)).toEqual(DEFAULT_ANALYSIS_PROMPTS);
    expect(getGenerationPrompts(dataDir)).toEqual(DEFAULT_GENERATION_PROMPTS_DATA);
    expect(fs.existsSync(file())).toBe(false);
  });

  it("changing one set writes exactly that key, with the other sets built-in", () => {
    saveSettings(dataDir, { ...getSettings(dataDir), editorWatermark: "Write here" });
    expect(saved()).toEqual({ editorWatermark: "Write here" });
    expect(getSettings(dataDir)).toEqual({ ...DEFAULT_SETTINGS, editorWatermark: "Write here" });
    expect(getAnalysisPrompts(dataDir)).toEqual(DEFAULT_ANALYSIS_PROMPTS);
  });

  it("preserves other known copies and removes unknown keys on write", () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 7, timezone: "UTC", targets: [] }));
    const generationPrompts = { prompts: { ...DEFAULT_GENERATION_PROMPTS_DATA.prompts, title: "Custom" } };
    saveGenerationPrompts(dataDir, generationPrompts);
    expect(saved()).toEqual({ timezone: "UTC", generationPrompts });
    expect(getGenerationPrompts(dataDir)).toEqual(generationPrompts);
  });

  it("reads a partial generation prompt map as absent and warns without changing the file", () => {
    const partial = { generationPrompts: { prompts: { title: "Custom" } } };
    fs.writeFileSync(file(), JSON.stringify(partial));
    const warning = vi.spyOn(logger, "warn");
    try {
      expect(getGenerationPrompts(dataDir)).toEqual(DEFAULT_GENERATION_PROMPTS_DATA);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: "generationPrompts" }));
      expect(saved()).toEqual(partial);
    } finally { warning.mockRestore(); }
  });

  it("reads a partial contentFont as absent rather than merging its members", () => {
    fs.writeFileSync(file(), JSON.stringify({ contentFont: { family: "Custom" } }));
    expect(getSettings(dataDir).contentFont).toEqual(DEFAULT_CONTENT_FONT);
    expect(saved()).toEqual({ contentFont: { family: "Custom" } });
  });

  it("changing one role's model writes only that role's set", () => {
    const defaults = defaultAnthropicSettings();
    // Sonnet's own default is adaptive, whichever role chooses it.
    saveAnthropicSettings(ws, { ...defaults, models: { ...defaults.models, metadata: "claude-sonnet-5-5" }, thinking: { ...defaults.thinking, metadata: "adaptive" } });
    expect(saved()).toEqual({ "anthropic.metadata": "claude-sonnet-5-5" });
    saveAnthropicSettings(ws, { ...defaults, models: { ...defaults.models, metadata: "claude-sonnet-5-5" }, thinking: { ...defaults.thinking, metadata: "between_tools" } });
    expect(saved()).toEqual({ "anthropic.metadata": "claude-sonnet-5-5", "anthropic.thinking.metadata": "between_tools" });
  });

  it("saving a set equal to its built-in removes its key and keeps the file", () => {
    const targets = [{ name: "blog", defaultLanguage: "en", requiresMetadata: false }];
    saveTargets(dataDir, targets);
    saveGenerationPrompts(dataDir, { prompts: { ...DEFAULT_GENERATION_PROMPTS_DATA.prompts, title: "Custom" } });
    saveAnalysisPrompts(dataDir, [{ name: "Mine", text: "Custom" }]);
    saveGenerationPrompts(dataDir, structuredClone(DEFAULT_GENERATION_PROMPTS_DATA));
    expect(saved()).toEqual({ targets, analysisPrompts: [{ name: "Mine", text: "Custom" }] });
    saveAnalysisPrompts(dataDir, structuredClone(DEFAULT_ANALYSIS_PROMPTS));
    saveTargets(dataDir, []);
    expect(saved()).toEqual({});
  });

  it("saving built-ins into a fresh workspace creates no file", () => {
    saveGenerationPrompts(dataDir, structuredClone(DEFAULT_GENERATION_PROMPTS_DATA));
    saveAnalysisPrompts(dataDir, structuredClone(DEFAULT_ANALYSIS_PROMPTS));
    saveSettings(dataDir, getSettings(dataDir));
    expect(fs.existsSync(file())).toBe(false);
  });

  it("compares a set with its built-in regardless of key order", () => {
    const reordered = { prompts: Object.fromEntries(Object.entries(DEFAULT_GENERATION_PROMPTS_DATA.prompts).reverse()) };
    saveTargets(dataDir, [{ name: "blog", defaultLanguage: "en", requiresMetadata: false }]);
    saveGenerationPrompts(dataDir, reordered);
    expect(Object.keys(saved())).toEqual(["targets"]);
  });
});

it("a partial dialog save preserves another set changed after the dialog opened", () => {
  saveSettings(dataDir, { timezone: "UTC" });
  saveSettings(dataDir, { uiFontFamily: "Iosevka" });
  expect(getSettings(dataDir)).toEqual({ ...DEFAULT_SETTINGS, timezone: "UTC", uiFontFamily: "Iosevka" });
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"))).toEqual({ timezone: "UTC", uiFontFamily: "Iosevka" });
});

it("warns on each read of an invalid workspace set and names its key", () => {
  const warning = vi.spyOn(logger, "warn");
  try {
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ contentFont: { family: "Partial" } }));
    getSettings(dataDir);
    getTargets(dataDir);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: "contentFont" }));
  } finally { warning.mockRestore(); }
});

it.each([
  ["a value outside the app's own range", { publishedPostsPerLoad: 0 }, "publishedPostsPerLoad"],
  ["a target with a blank name", { targets: [{ name: " ", defaultLanguage: "en", requiresMetadata: false }] }, "targets"],
  ["an analysis prompt with a blank name", { analysisPrompts: [{ name: "", text: "t" }] }, "analysisPrompts"],
])("reads %s as its built-in, by the validator Save uses", (_case, stored, key) => {
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(stored));
  const config = { ...makeDefaultConfig(), ...getSettings(dataDir), targets: getTargets(dataDir), analysisPrompts: getAnalysisPrompts(dataDir) };
  expect(config[key as keyof typeof config]).toEqual(makeDefaultConfig()[key as keyof ReturnType<typeof makeDefaultConfig>]);
});

it("a settings save writes every set from what the store holds", () => {
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ supportedLanguages: ["ja", "en", "ja"] }));
  const saved = saveSettings(dataDir, { uiFontFamily: "Iosevka" });
  expect(saved.supportedLanguages).toEqual(["en", "ja"]);
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"))).toEqual({
    supportedLanguages: ["en", "ja"],
    uiFontFamily: "Iosevka",
  });
});
