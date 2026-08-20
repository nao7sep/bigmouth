import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "@shared/types";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import { initAppDir } from "@main/core/services/workspaceStore.js";
import { getApiKeysPath } from "@main/core/services/storagePaths.js";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { DEFAULT_SETTINGS } from "@main/core/shared/defaults.js";
import {
  getSettings,
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
const SAVED_HOME = process.env.BIGMOUTH_HOME;
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
  process.env.BIGMOUTH_HOME = homeDir;
  delete process.env.ANTHROPIC_API_KEY;
  initAppDir();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-configstore-"));
  ws = workspaceAt("ws-1", dataDir);
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("corrupt config files", () => {
  it("surfaces a clear error naming the file rather than a bare SyntaxError", () => {
    fs.writeFileSync(path.join(dataDir, "config.json"), "{ not valid json", "utf-8");
    expect(() => getSettings(dataDir)).toThrow(/config\.json is not valid JSON/);
  });

  // A file that parses but does not fit the shape is corrupt too, and it used to
  // take a different, destructive branch: the section normalizers coerced the
  // damaged sections to empty, and because every save reads-spreads-writes, the
  // next Settings save persisted that emptiness over the user's authored targets,
  // AI configs and prompts.
  it("refuses a config whose shape is damaged, instead of coercing it to defaults", () => {
    const configPath = path.join(dataDir, "config.json");
    const healthy = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const authoredTargets = [{ rowId: "r1", name: "blog", defaultLanguage: "en", requiresMetadata: false }];
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...healthy, targets: authoredTargets, analysisPrompts: "not an array" }),
      "utf-8",
    );

    expect(() => getSettings(dataDir)).toThrow(/not a BigMouth workspace config/);
    expect(() => saveSettings(dataDir, DEFAULT_SETTINGS)).toThrow(/not a BigMouth workspace config/);

    // Nothing was written: the authored targets are still on disk.
    const afterwards = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(afterwards.targets).toEqual(authoredTargets);
    expect(afterwards.analysisPrompts).toBe("not an array");
  });

  it("leaves a config written by a newer build exactly where it is", () => {
    // Not corrupt — intact data this build cannot read. Reported by name, never
    // written to, which the throw is what guarantees since every save reads first.
    const configPath = path.join(dataDir, "config.json");
    const healthy = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    fs.writeFileSync(configPath, JSON.stringify({ ...healthy, schemaVersion: 99 }), "utf-8");

    expect(() => getSettings(dataDir)).toThrow(/written by a newer version of BigMouth/);

    const afterwards = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(afterwards.schemaVersion).toBe(99);
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
    // The structural sections are present because every build that has ever
    // shipped wrote them — isWorkspaceConfig has required all five since v0.1.0,
    // and a folder whose config lacks them does not register as a workspace at
    // all. What this test is actually about is the SETTINGS fields, which a file
    // written before a setting existed genuinely will not carry.
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
    // The shared default, not a copy of its values: main materializes what
    // @shared/types declares, so an edit there must not leave this test passing.
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
