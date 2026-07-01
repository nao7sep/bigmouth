// Proves the single storage-root resolution in workspaceStore.ts:
//   - BIGMOUTH_HOME set   → the whole ~/.bigmouth root relocates under it
//   - BIGMOUTH_HOME unset → the root defaults to <home>/.bigmouth
//   - a relative BIGMOUTH_HOME resolves against the home directory, never the cwd
// Relocation is driven through the BIGMOUTH_HOME environment variable — the one
// supported relocation seam — never a private setter.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initAppDir, getLogsDir, createWorkspace } from "@main/core/services/workspaceStore.js";

const SAVED_HOME = process.env.BIGMOUTH_HOME;
const SAVED_TEST_BASE = process.env.BIGMOUTH_TEST_BASE;

beforeEach(() => {
  delete process.env.BIGMOUTH_HOME;
  delete process.env.BIGMOUTH_TEST_BASE;
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  if (SAVED_TEST_BASE === undefined) delete process.env.BIGMOUTH_TEST_BASE;
  else process.env.BIGMOUTH_TEST_BASE = SAVED_TEST_BASE;
});

describe("storage root (BIGMOUTH_HOME)", () => {
  it("relocates the whole root under BIGMOUTH_HOME when set", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-home-"));
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      expect(getLogsDir()).toBe(path.join(root, "logs"));
      expect(fs.existsSync(path.join(root, "logs"))).toBe(true);
      expect(fs.existsSync(path.join(root, "workspaces.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the workspace registry workspaces.json, never the old app.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-registry-"));
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      // The registry is created on first init and must land at workspaces.json.
      expect(fs.existsSync(path.join(root, "workspaces.json"))).toBe(true);
      expect(fs.existsSync(path.join(root, "app.json"))).toBe(false);

      // A write (adding a workspace) must persist to the same workspaces.json,
      // and must not resurrect an app.json under any code path.
      createWorkspace("Registry WS");
      expect(fs.existsSync(path.join(root, "workspaces.json"))).toBe(true);
      expect(fs.existsSync(path.join(root, "app.json"))).toBe(false);

      const parsed = JSON.parse(fs.readFileSync(path.join(root, "workspaces.json"), "utf-8"));
      expect(Array.isArray(parsed.workspaces)).toBe(true);
      expect(parsed.workspaces).toHaveLength(1);
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

  it("expands a leading ~ in BIGMOUTH_HOME against the home directory", () => {
    const expected = path.join(os.homedir(), ".bigmouth-test-tilde");
    try {
      process.env.BIGMOUTH_HOME = "~/.bigmouth-test-tilde";
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      fs.rmSync(expected, { recursive: true, force: true });
    }
  });

  it("expands a $VAR reference in BIGMOUTH_HOME", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-var-"));
    const expected = path.join(base, "root");
    try {
      process.env.BIGMOUTH_TEST_BASE = base;
      process.env.BIGMOUTH_HOME = "$BIGMOUTH_TEST_BASE/root";
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("expands a %VAR% reference in BIGMOUTH_HOME", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-pctvar-"));
    const expected = path.join(base, "root");
    try {
      process.env.BIGMOUTH_TEST_BASE = base;
      process.env.BIGMOUTH_HOME = "%BIGMOUTH_TEST_BASE%/root";
      initAppDir();
      expect(getLogsDir()).toBe(path.join(expected, "logs"));
      expect(fs.existsSync(path.join(expected, "logs"))).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("throws the startup error when BIGMOUTH_HOME resolves to an unusable root", () => {
    // Point the root at a regular file: mkdirSync over an existing file fails,
    // and the resolver must surface that loudly rather than fall back to the
    // default ~/.bigmouth.
    const file = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-badroot-"));
    const filePath = path.join(file, "not-a-dir");
    fs.writeFileSync(filePath, "i am a file, not a directory");
    try {
      process.env.BIGMOUTH_HOME = filePath;
      expect(() => initAppDir()).toThrow(/Cannot use the bigmouth storage root/);
    } finally {
      fs.rmSync(file, { recursive: true, force: true });
    }
  });
});

describe("workspace paths are cwd-independent", () => {
  it("resolves a relative workspace dataDirectory under the home root, not the cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ws-cwd-"));
    const rel = "my-relative-workspace";
    try {
      process.env.BIGMOUTH_HOME = root;
      initAppDir();
      // The home directory drives the expansion pipeline (os.homedir()), not the
      // storage root, so a relative workspace path lands under the user's home.
      const expected = path.join(os.homedir(), rel);
      const workspace = createWorkspace("Relative WS", rel);
      expect(path.isAbsolute(workspace.dataDirectory)).toBe(true);
      expect(workspace.dataDirectory).toBe(expected);
      expect(workspace.dataDirectory).not.toBe(path.join(process.cwd(), rel));
      expect(workspace.dataDirectory.startsWith(os.homedir())).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), rel), { recursive: true, force: true });
    }
  });
});
