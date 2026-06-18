// Proves the single storage-root resolution in workspaceStore.ts and the
// environment-first secret resolution in configStore.ts:
//   - BIGMOUTH_HOME set   → the whole ~/.bigmouth root relocates under it
//   - BIGMOUTH_HOME unset → the root defaults to <home>/.bigmouth
//   - a relative BIGMOUTH_HOME resolves against the home directory, never the cwd
//   - an env API key wins over the stored (obfuscated) one
// Relocation is driven through the BIGMOUTH_HOME environment variable — the one
// supported relocation seam — never a private setter.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, getLogsDir } from "../../src/../src/services/workspaceStore.js";
import { initializeWorkspaceData } from "../../src/../src/services/dataDir.js";
import {
  createAiConfig,
  setActiveAiConfig,
  getActiveAiConfig,
} from "../../src/../src/services/configStore.js";

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  delete process.env.BIGMOUTH_HOME;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
});

describe("storage root (BIGMOUTH_HOME)", () => {
  it("relocates the whole root under BIGMOUTH_HOME when set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-home-"));
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      expect(getLogsDir()).toBe(path.join(root, "logs"));
      expect(fs.existsSync(path.join(root, "logs"))).toBe(true);
      expect(fs.existsSync(path.join(root, "app.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults the root to <home>/.bigmouth when BIGMOUTH_HOME is unset", () => {
    initAppDir();
    expect(getLogsDir()).toBe(path.join(os.homedir(), ".bigmouth", "logs"));
  });

  it("resolves a relative BIGMOUTH_HOME against the home directory, never the cwd", () => {
    const rel = ".bigmouth-test-relative";
    const expected = path.join(os.homedir(), rel);
    try {
      process.env.BIGMOUTH_HOME = rel;
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(getLogsDir()).not.toBe(path.join(process.cwd(), rel, "logs"));
    } finally {
      fs.rmSync(expected, { recursive: true, force: true });
    }
  });
});

describe("secret resolution (environment-first)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-secrets-"));
    initializeWorkspaceData(dataDir);
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("prefers an env API key over the stored obfuscated one", () => {
    createAiConfig(dataDir, {
      id: "c1",
      name: "Test",
      provider: "claude",
      model: "claude-test",
      apiKey: "sk-ant-stored",
    });
    setActiveAiConfig(dataDir, "c1");

    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    expect(getActiveAiConfig(dataDir)?.apiKey).toBe("sk-ant-from-env");

    delete process.env.ANTHROPIC_API_KEY;
    expect(getActiveAiConfig(dataDir)?.apiKey).toBe("sk-ant-stored");
  });

  it("uses the env API key even when no key is stored", () => {
    createAiConfig(dataDir, {
      id: "c1",
      name: "Test",
      provider: "claude",
      model: "claude-test",
    });
    setActiveAiConfig(dataDir, "c1");

    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    expect(getActiveAiConfig(dataDir)?.apiKey).toBe("sk-ant-from-env");
  });
});
