import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
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

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-configstore-"));
  initializeWorkspaceData(dataDir);
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("corrupt config files", () => {
  it("surfaces a clear error naming the file rather than a bare SyntaxError", () => {
    fs.writeFileSync(path.join(dataDir, "settings.json"), "{ not valid json", "utf-8");
    expect(() => getSettings(dataDir)).toThrow(/settings\.json is not valid JSON/);
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
});

describe("AI config API key handling", () => {
  it("stores the key obfuscated and never exposes plaintext to the client", () => {
    createAiConfig(dataDir, {
      id: "c1",
      name: "Claude",
      provider: "claude",
      model: "claude-opus-4-8",
      apiKey: "sk-ant-secret",
    });

    // On-disk file must not contain the plaintext key.
    const onDisk = fs.readFileSync(path.join(dataDir, "ai-configs.json"), "utf-8");
    expect(onDisk).not.toContain("sk-ant-secret");

    // Client view carries no key, only the hasApiKey flag.
    const created = getAiConfigsForClient(dataDir).configs.find((c) => c.id === "c1");
    expect(created?.apiKey).toBe("");
    expect(created?.hasApiKey).toBe(true);
  });

  it("getActiveAiConfig returns the deobfuscated key for the active config", () => {
    createAiConfig(dataDir, {
      id: "c1",
      name: "Claude",
      provider: "claude",
      model: "claude-opus-4-8",
      apiKey: "sk-ant-secret",
    });
    setActiveAiConfig(dataDir, "c1");

    const active = getActiveAiConfig(dataDir);
    expect(active?.apiKey).toBe("sk-ant-secret");
  });

  it("preserves the key when apiKey is omitted from an update", () => {
    createAiConfig(dataDir, {
      id: "c1",
      name: "Claude",
      provider: "claude",
      model: "claude-opus-4-8",
      apiKey: "sk-ant-secret",
    });
    setActiveAiConfig(dataDir, "c1");

    updateAiConfig(dataDir, "c1", { name: "Renamed" });
    expect(getActiveAiConfig(dataDir)?.apiKey).toBe("sk-ant-secret");
    const renamed = getAiConfigsForClient(dataDir).configs.find((c) => c.id === "c1");
    expect(renamed?.name).toBe("Renamed");
  });

  it("clears the key when apiKey is an empty string", () => {
    createAiConfig(dataDir, {
      id: "c1",
      name: "Claude",
      provider: "claude",
      model: "claude-opus-4-8",
      apiKey: "sk-ant-secret",
    });
    setActiveAiConfig(dataDir, "c1");

    updateAiConfig(dataDir, "c1", { apiKey: "" });
    expect(getActiveAiConfig(dataDir)?.apiKey).toBe("");
    expect(getAiConfigsForClient(dataDir).configs[0].hasApiKey).toBe(false);
  });
});

describe("AI config lifecycle guards", () => {
  it("refuses to delete the active config", () => {
    createAiConfig(dataDir, {
      id: "c1",
      name: "Claude",
      provider: "claude",
      model: "claude-opus-4-8",
    });
    setActiveAiConfig(dataDir, "c1");
    expect(() => deleteAiConfig(dataDir, "c1")).toThrow(/active/i);
  });

  it("deletes a non-active config", () => {
    createAiConfig(dataDir, { id: "c1", name: "A", provider: "claude", model: "m" });
    createAiConfig(dataDir, { id: "c2", name: "B", provider: "claude", model: "m" });
    setActiveAiConfig(dataDir, "c1");

    const result = deleteAiConfig(dataDir, "c2");
    const ids = result.configs.map((c) => c.id);
    expect(ids).toContain("c1");
    expect(ids).not.toContain("c2");
  });

  it("rejects a duplicate config id", () => {
    createAiConfig(dataDir, { id: "c1", name: "A", provider: "claude", model: "m" });
    expect(() =>
      createAiConfig(dataDir, { id: "c1", name: "Dup", provider: "claude", model: "m" })
    ).toThrow(/already exists/i);
  });

  it("rejects activating a config that does not exist", () => {
    expect(() => setActiveAiConfig(dataDir, "ghost")).toThrow(/not found/i);
  });
});
