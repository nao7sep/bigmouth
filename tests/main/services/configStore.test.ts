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
import { DEFAULT_SETTINGS, makeDefaultConfig, makeDefaultAiConfigs, DEFAULT_ANALYSIS_PROMPTS, DEFAULT_GENERATION_PROMPTS_DATA } from "@main/core/shared/defaults.js";
import {
  getSettings,
  getTargets,
  saveTargets,
  getAnalysisPrompts,
  saveAnalysisPrompts,
  getGenerationPrompts,
  saveGenerationPrompts,
  saveSettings,
  createAiConfig,
  updateAiConfig,
  deleteAiConfig,
  setActiveAiConfig,
  getActiveAiConfig,
  getAiConfigsForClient,
} from "@main/core/services/configStore.js";

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

  it("reads duplicate AI config ids as an invalid aiConfigs set without rewriting", () => {
    const configPath = path.join(dataDir, "config.json");
    const healthy = makeDefaultConfig();
    const duplicate = JSON.stringify({
      ...healthy,
      aiConfigs: [healthy.aiConfigs[0], { ...healthy.aiConfigs[0], name: "Ambiguous copy" }],
    });
    fs.writeFileSync(configPath, duplicate, "utf8");

    expect(getAiConfigsForClient(ws).configs.map((c) => c.id)).toEqual(["default"]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(duplicate);
  });

  it.each([
    ["empty", ""],
    ["outside the management grammar", "bad id!"],
  ])("reads an %s AI config id as an invalid set without rewriting", (_case, id) => {
    const configPath = path.join(dataDir, "config.json");
    const healthy = makeDefaultConfig();
    const malformed = JSON.stringify({
      ...healthy,
      aiConfigs: [{ ...healthy.aiConfigs[0], id }],
    });
    fs.writeFileSync(configPath, malformed, "utf8");

    expect(getAiConfigsForClient(ws).configs.map((c) => c.id)).toEqual(["default"]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(malformed);
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
        aiConfigs: [],
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

describe("AI config API key handling", () => {
  it("keeps the key out of the workspace file and in the storage-root secrets file", () => {
    createAiConfig(ws, {
      id: "c1",
      name: "Claude",
      provider: "anthropic",
      model: "claude-opus-5",
      thinking: false,
      maxTokens: 12800,
      apiKey: "sk-ant-secret",
    });

    // The git-versionable workspace file carries no key at all — not even the field.
    const onDisk = fs.readFileSync(path.join(dataDir, "config.json"), "utf-8");
    expect(onDisk).not.toContain("sk-ant-secret");
    expect(onDisk).not.toContain("apiKey");

    // The key lives in the secrets file, keyed by (workspace id, config id), obfuscated.
    const secrets = fs.readFileSync(getApiKeysPath(), "utf-8");
    expect(secrets).not.toContain("sk-ant-secret");
    expect(JSON.parse(secrets).workspaces[ws.id].configs.c1.keys.anthropic).toBeTruthy();

    // Client view carries no key, only the hasApiKey flag.
    const created = getAiConfigsForClient(ws).configs.find((c) => c.id === "c1");
    expect(created?.apiKey).toBe("");
    expect(created?.hasApiKey).toBe(true);
    expect(created?.usingEnvKey).toBe(false);
  });

  it("getActiveAiConfig returns the deobfuscated key for the active config", () => {
    createAiConfig(ws, {
      id: "c1",
      name: "Claude",
      provider: "anthropic",
      model: "claude-opus-5",
      thinking: false,
      maxTokens: 12800,
      apiKey: "sk-ant-secret",
    });
    setActiveAiConfig(ws, "c1");

    expect(getActiveAiConfig(ws)?.apiKey).toBe("sk-ant-secret");
  });

  it("preserves the key when apiKey is omitted from an update", () => {
    createAiConfig(ws, { id: "c1", name: "Claude", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800, apiKey: "sk-ant-secret" });
    setActiveAiConfig(ws, "c1");

    updateAiConfig(ws, "c1", { name: "Renamed" });
    expect(getActiveAiConfig(ws)?.apiKey).toBe("sk-ant-secret");
    expect(getAiConfigsForClient(ws).configs.find((c) => c.id === "c1")?.name).toBe("Renamed");
  });

  it("applies every editable field, not just the three it used to", () => {
    // thinking and maxTokens were declared on the patch type, validated by the
    // IPC handler and logged as changed, then dropped: the store applied only
    // name/provider/model. The user toggled Thinking or edited Max tokens, the
    // modal repainted from the returned view with the old values, and every AI
    // call kept the previous budget.
    createAiConfig(ws, { id: "c1", name: "Claude", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800, apiKey: "k" });

    const returned = updateAiConfig(ws, "c1", { thinking: true, maxTokens: 32000 });

    const applied = returned.configs.find((c) => c.id === "c1");
    expect(applied?.thinking).toBe(true);
    expect(applied?.maxTokens).toBe(32000);

    // And it reached disk, not just the returned view.
    const onDisk = getAiConfigsForClient(ws).configs.find((c) => c.id === "c1");
    expect(onDisk?.thinking).toBe(true);
    expect(onDisk?.maxTokens).toBe(32000);
  });

  it("clears the key when apiKey is blank", () => {
    createAiConfig(ws, { id: "c1", name: "Claude", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800, apiKey: "sk-ant-secret" });
    setActiveAiConfig(ws, "c1");

    updateAiConfig(ws, "c1", { apiKey: "" });
    expect(getActiveAiConfig(ws)?.apiKey).toBe("");
    expect(getAiConfigsForClient(ws).configs[0].hasApiKey).toBe(false);
  });

  it("a key-only update does not rewrite the git-versioned config.json", () => {
    createAiConfig(ws, { id: "c1", name: "Claude", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800, apiKey: "old" });
    setActiveAiConfig(ws, "c1");
    const configPath = path.join(dataDir, "config.json");
    const before = fs.readFileSync(configPath, "utf-8");

    updateAiConfig(ws, "c1", { apiKey: "new-key" });

    expect(fs.readFileSync(configPath, "utf-8")).toBe(before); // workspace file untouched
    expect(getActiveAiConfig(ws)?.apiKey).toBe("new-key"); // but the key did change
  });

  it("deleteAiConfig also removes the stored key", () => {
    createAiConfig(ws, { id: "c1", name: "A", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800 });
    createAiConfig(ws, { id: "c2", name: "B", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800, apiKey: "sk-c2" });
    setActiveAiConfig(ws, "c1");

    deleteAiConfig(ws, "c2");
    const secrets = JSON.parse(fs.readFileSync(getApiKeysPath(), "utf-8"));
    expect(secrets.workspaces[ws.id]?.configs?.c2).toBeUndefined();
  });

  it("hasApiKey is stored-only while usingEnvKey reflects the environment", () => {
    createAiConfig(ws, { id: "c1", name: "A", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800 }); // no stored key
    setActiveAiConfig(ws, "c1");
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";

    const view = getAiConfigsForClient(ws).configs[0];
    expect(view.hasApiKey).toBe(false); // nothing stored for this config
    expect(view.usingEnvKey).toBe(true); // env overrides
    expect(getActiveAiConfig(ws)?.apiKey).toBe("sk-ant-from-env"); // resolution still env-first
  });

  it("keeps keys independent for two workspaces that share a config id", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-configstore2-"));
    try {
      const ws2 = workspaceAt("ws-2", otherDir);
      createAiConfig(ws, { id: "shared", name: "A", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800, apiKey: "key-ws1" });
      createAiConfig(ws2, { id: "shared", name: "B", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800, apiKey: "key-ws2" });
      setActiveAiConfig(ws, "shared");
      setActiveAiConfig(ws2, "shared");

      expect(getActiveAiConfig(ws)?.apiKey).toBe("key-ws1");
      expect(getActiveAiConfig(ws2)?.apiKey).toBe("key-ws2");
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("AI config lifecycle guards", () => {
  it("deleting the active config falls the active back to the first remaining", () => {
    createAiConfig(ws, { id: "c1", name: "A", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800 });
    setActiveAiConfig(ws, "c1");
    const after = deleteAiConfig(ws, "c1");
    expect(after.configs.some((c) => c.id === "c1")).toBe(false);
    expect(after.activeId).toBe(after.configs[0].id); // active = first remaining config
  });

  it("deletes a non-active config", () => {
    createAiConfig(ws, { id: "c1", name: "A", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800 });
    createAiConfig(ws, { id: "c2", name: "B", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800 });
    setActiveAiConfig(ws, "c1");

    const ids = deleteAiConfig(ws, "c2").configs.map((c) => c.id);
    expect(ids).toContain("c1");
    expect(ids).not.toContain("c2");
  });

  it("rejects a duplicate config id", () => {
    createAiConfig(ws, { id: "c1", name: "A", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800 });
    expect(() =>
      createAiConfig(ws, { id: "c1", name: "Dup", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800 }),
    ).toThrow(/already exists/i);
  });

  it("rejects activating a config that does not exist", () => {
    expect(() => setActiveAiConfig(ws, "ghost")).toThrow(/not found/i);
  });

  it("rejects updating a config that does not exist", () => {
    expect(() => updateAiConfig(ws, "ghost", { name: "x" })).toThrow(/not found/i);
  });

  it("an empty active id clears the session selection, falling back to the first config", () => {
    createAiConfig(ws, { id: "c1", name: "A", provider: "anthropic", model: "m", thinking: false, maxTokens: 12800 });
    setActiveAiConfig(ws, "c1");
    const after = setActiveAiConfig(ws, "");
    expect(after.activeId).toBe(after.configs[0].id); // back to the first config
  });

  it("resolves to no active config only when there are no configs", () => {
    for (const c of getAiConfigsForClient(ws).configs) deleteAiConfig(ws, c.id);
    expect(getAiConfigsForClient(ws).activeId).toBe(""); // no configs → none
    expect(getActiveAiConfig(ws)).toBeNull();
  });
});

describe("settings stored by set", () => {
  const file = () => path.join(dataDir, "config.json");
  const saved = () => JSON.parse(fs.readFileSync(file(), "utf8"));

  it("reads all built-ins without seeding a file", () => {
    expect(getSettings(dataDir)).toEqual(DEFAULT_SETTINGS);
    expect(getTargets(dataDir)).toEqual([]);
    expect(getAiConfigsForClient(ws).configs[0]).toMatchObject({ id: "default", maxTokens: 16384 });
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

  it("editing the built-in AI config writes only aiConfigs, including all its members", () => {
    updateAiConfig(ws, "default", { name: "Mine" });
    expect(saved()).toEqual({ aiConfigs: [{ ...makeDefaultAiConfigs()[0], name: "Mine" }] });
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
