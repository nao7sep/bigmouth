import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveApiKey,
  readStoredConfigIds,
  hasEnvApiKey,
  writeApiKey,
  clearApiKey,
  clearWorkspaceKeys,
} from "@main/core/services/apiKeys.js";
import { obfuscate } from "@main/core/shared/obfuscation.js";

let dir: string;
let keyFile: string;
const W1 = "ws-one";
const W2 = "ws-two";
const SAVED_ANTHROPIC = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-apikeys-"));
  keyFile = path.join(dir, "api-keys.json");
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  if (SAVED_ANTHROPIC === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED_ANTHROPIC;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("apiKeys secret store", () => {
  it("writes, resolves, and clears a key; stores it obfuscated, never plaintext", () => {
    expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBeNull();
    expect(readStoredConfigIds(keyFile, W1).has("c1")).toBe(false);

    writeApiKey(keyFile, W1, "c1", "sk-ant-secret");
    expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBe("sk-ant-secret");
    expect(readStoredConfigIds(keyFile, W1).has("c1")).toBe(true);

    const raw = fs.readFileSync(keyFile, "utf-8");
    expect(raw).not.toContain("sk-ant-secret"); // obfuscated, not plaintext
    expect(JSON.parse(raw).workspaces[W1].c1).toBeTruthy(); // nested by (workspace, config)

    clearApiKey(keyFile, W1, "c1");
    expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBeNull();
  });

  it("keeps keys independent per config id within a workspace", () => {
    writeApiKey(keyFile, W1, "c1", "key-one");
    writeApiKey(keyFile, W1, "c2", "key-two");
    expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBe("key-one");
    expect(resolveApiKey(keyFile, W1, "c2", "claude")).toBe("key-two");

    clearApiKey(keyFile, W1, "c1");
    expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBeNull();
    expect(resolveApiKey(keyFile, W1, "c2", "claude")).toBe("key-two");
  });

  it("keeps keys independent across workspaces that share a config id", () => {
    // The core fix: a config id travels in the committed ai-configs.json, so two
    // workspaces (a copied/cloned folder) can hold the same id without colliding.
    writeApiKey(keyFile, W1, "shared", "key-w1");
    writeApiKey(keyFile, W2, "shared", "key-w2");
    expect(resolveApiKey(keyFile, W1, "shared", "claude")).toBe("key-w1");
    expect(resolveApiKey(keyFile, W2, "shared", "claude")).toBe("key-w2");

    // Setting/clearing in one must not touch the other.
    clearApiKey(keyFile, W1, "shared");
    expect(resolveApiKey(keyFile, W1, "shared", "claude")).toBeNull();
    expect(resolveApiKey(keyFile, W2, "shared", "claude")).toBe("key-w2");
  });

  it("clearWorkspaceKeys drops only that workspace's keys", () => {
    writeApiKey(keyFile, W1, "c1", "a");
    writeApiKey(keyFile, W1, "c2", "b");
    writeApiKey(keyFile, W2, "c1", "c");

    clearWorkspaceKeys(keyFile, W1);
    expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBeNull();
    expect(resolveApiKey(keyFile, W1, "c2", "claude")).toBeNull();
    expect(resolveApiKey(keyFile, W2, "c1", "claude")).toBe("c");
    // The emptied workspace bucket leaves no trace.
    expect(JSON.parse(fs.readFileSync(keyFile, "utf-8")).workspaces[W1]).toBeUndefined();
  });

  it("readStoredConfigIds reports only stored ids, excluding the environment", () => {
    writeApiKey(keyFile, W1, "c1", "stored");
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    // c2 has no stored key; the env var must NOT make it look stored.
    const ids = readStoredConfigIds(keyFile, W1);
    expect(ids.has("c1")).toBe(true);
    expect(ids.has("c2")).toBe(false);
  });

  it("hasEnvApiKey reflects the provider env var", () => {
    expect(hasEnvApiKey("claude")).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect(hasEnvApiKey("claude")).toBe(true);
  });

  describe("environment-first resolution", () => {
    it("prefers a set env key over the stored one and never persists it", () => {
      writeApiKey(keyFile, W1, "c1", "sk-ant-stored");
      process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBe("sk-ant-from-env");
      expect(fs.readFileSync(keyFile, "utf-8")).not.toContain("sk-ant-from-env");

      delete process.env.ANTHROPIC_API_KEY;
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBe("sk-ant-stored");
    });

    it("trims the env value and ignores a blank one", () => {
      writeApiKey(keyFile, W1, "c1", "sk-ant-stored");
      process.env.ANTHROPIC_API_KEY = "  sk-trimmed  ";
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBe("sk-trimmed");

      process.env.ANTHROPIC_API_KEY = "   ";
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBe("sk-ant-stored"); // blank env → fall through
    });
  });

  describe("blank-key and whitespace handling", () => {
    it("treats a blank or whitespace written key as a removal", () => {
      writeApiKey(keyFile, W1, "c1", "sk-ant-secret");
      writeApiKey(keyFile, W1, "c1", "   ");
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBeNull();
    });

    it("trims a stored key, so a leading/trailing-space key resolves trimmed", () => {
      writeApiKey(keyFile, W1, "c1", "  sk-spaced  ");
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBe("sk-spaced");
    });

    it("does not create the file when clearing a key that was never set", () => {
      clearApiKey(keyFile, W1, "c1");
      expect(fs.existsSync(keyFile)).toBe(false);
      writeApiKey(keyFile, W1, "c1", ""); // blank write on an absent key is also a no-op
      expect(fs.existsSync(keyFile)).toBe(false);
    });
  });

  describe("corrupt / hand-edited file tolerance", () => {
    it("treats unparseable JSON as empty rather than throwing", () => {
      fs.writeFileSync(keyFile, "{ not json");
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBeNull();
      expect(readStoredConfigIds(keyFile, W1).size).toBe(0);
    });

    it("ignores a non-string stored value instead of crashing on it", () => {
      // A hand-edited file with a number/object value must not reach Buffer.from.
      fs.writeFileSync(
        keyFile,
        JSON.stringify({ workspaces: { [W1]: { c1: 123, c2: obfuscate("real") } } }),
      );
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBeNull(); // bad entry → absent
      expect(resolveApiKey(keyFile, W1, "c2", "claude")).toBe("real"); // good entry still resolves
    });

    it("treats a wrong-typed workspaces field as empty", () => {
      fs.writeFileSync(keyFile, JSON.stringify({ workspaces: [] }));
      expect(resolveApiKey(keyFile, W1, "c1", "claude")).toBeNull();
    });
  });
});

describe("file permissions (POSIX only)", () => {
  it.runIf(process.platform !== "win32")("creates the secrets file 0600", () => {
    writeApiKey(keyFile, W1, "c1", "sk-ant-secret");
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")("tightens a group/world-readable file back to 0600 on read", () => {
    writeApiKey(keyFile, W1, "c1", "sk-ant-secret");
    fs.chmodSync(keyFile, 0o644);
    // Any read path runs the mode check; resolving a key tightens it back.
    resolveApiKey(keyFile, W1, "c1", "claude");
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });
});
