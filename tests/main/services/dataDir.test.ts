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

  it("leaves untouched settings in memory without creating config.json", () => {
    initializeWorkspaceData(dataDir);
    expect(fs.existsSync(path.join(dataDir, "config.json"))).toBe(false);
  });
});
