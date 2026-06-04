import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "../../src/../src/services/dataDir.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-datadir-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("initializeWorkspaceData", () => {
  it("creates the posts and assets directory tree", () => {
    initializeWorkspaceData(dataDir);
    for (const sub of [
      "posts/drafts",
      "posts/ready",
      "posts/published",
      "assets",
    ]) {
      expect(fs.existsSync(path.join(dataDir, sub))).toBe(true);
    }
  });

  it("writes all default config files as valid JSON", () => {
    initializeWorkspaceData(dataDir);
    for (const file of [
      "settings.json",
      "ai-configs.json",
      "generation-prompts.json",
      "targets.json",
      "analysis-prompts.json",
    ]) {
      const raw = fs.readFileSync(path.join(dataDir, file), "utf-8");
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it("seeds targets.json with an empty array", () => {
    initializeWorkspaceData(dataDir);
    const raw = fs.readFileSync(path.join(dataDir, "targets.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual([]);
  });
});
