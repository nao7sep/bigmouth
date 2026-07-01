// The home-root exclude list: durable data (including secrets) is kept; logs/, backups/, the internal
// workspaces/ tree, and atomic-write temporaries are dropped.

import { describe, it, expect } from "vitest";
import { isExcludedFile, isExcludedDir } from "@main/core/backup/homeRootExclusions.js";

describe("isExcludedFile", () => {
  it.each(["workspaces.json", "api-keys.json", "some/durable.json"])(
    "includes %s",
    (relativePath) => {
      expect(isExcludedFile(relativePath)).toBe(false);
    },
  );

  it.each([
    "logs/20260701.log",
    "backups/index.json",
    "backups/backup-20260701-000000-utc.zip",
    "workspaces/abc123/config.json",
    ".workspaces.json.1234.tmp",
  ])("excludes %s", (relativePath) => {
    expect(isExcludedFile(relativePath)).toBe(true);
  });
});

describe("isExcludedDir", () => {
  it("prunes the top-level logs, backups, and workspaces directories", () => {
    expect(isExcludedDir("logs")).toBe(true);
    expect(isExcludedDir("backups")).toBe(true);
    expect(isExcludedDir("workspaces")).toBe(true);
  });

  it("does not prune an unrelated directory", () => {
    expect(isExcludedDir("posts")).toBe(false);
  });
});
