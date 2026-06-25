import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";

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
    for (const sub of ["posts", "assets"]) {
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

  it("gives each workspace a unique default AI config id, even in the same session", () => {
    // The secret store keys by config id, so two workspaces sharing a default id
    // would share (and clobber) each other's key — they must differ.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-datadir-"));
    try {
      initializeWorkspaceData(dataDir);
      initializeWorkspaceData(other);
      const idHere = JSON.parse(fs.readFileSync(path.join(dataDir, "ai-configs.json"), "utf-8")).configs[0].id;
      const idOther = JSON.parse(fs.readFileSync(path.join(other, "ai-configs.json"), "utf-8")).configs[0].id;
      expect(idHere).not.toBe(idOther);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
