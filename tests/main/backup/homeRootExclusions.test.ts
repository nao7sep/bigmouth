// The home-root exclude list: durable data is kept; secrets (api-keys.json) and their .invalid quarantine
// files, logs/, backups/, the internal workspaces/ tree, and atomic-write temporaries are dropped.

import { describe, it, expect } from "vitest";
import {
  isExcludedFile,
  isExcludedDir,
  isNoiseOrTempFile,
} from "@main/core/backup/homeRootExclusions.js";

describe("isExcludedFile", () => {
  it.each(["workspaces.json", "some/durable.json"])(
    "includes %s",
    (relativePath) => {
      expect(isExcludedFile(relativePath)).toBe(false);
    },
  );

  it.each([
    "api-keys.json", // secret store — excluded, so no key material reaches a backup
    "Api-Keys.json", // basename matched case-insensitively
    "api-keys.json.20260701-000000-utc.invalid", // secret-store quarantine file
    "logs/20260701.log",
    "backups/index.json",
    "backups/backup-20260701-000000-utc.zip",
    "workspaces/abc123/config.json",
    ".workspaces.json.1234.tmp",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "Desktop.ini", // OS-noise floor, matched case-insensitively
  ])("excludes %s", (relativePath) => {
    expect(isExcludedFile(relativePath)).toBe(true);
  });
});

describe("isNoiseOrTempFile", () => {
  it.each([
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "Desktop.ini",
    ".workspaces.json.1234.tmp",
    "api-keys.json.20260701-000000-utc.invalid",
    "api-keys.json.20260701-000000-utc.INVALID", // case-insensitive
  ])("flags the litter base name %s", (name) => {
    expect(isNoiseOrTempFile(name)).toBe(true);
  });

  it.each(["config.json", "p1.md", "assets", "desktop.png"])(
    "keeps the real base name %s",
    (name) => {
      expect(isNoiseOrTempFile(name)).toBe(false);
    },
  );
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
