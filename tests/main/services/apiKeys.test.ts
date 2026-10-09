import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveApiKey,
  hasStoredApiKey,
  hasEnvApiKey,
  writeApiKey,
  clearWorkspaceKeys,
  keyFileProblem,
} from "@main/core/services/apiKeys.js";
import * as logger from "@main/core/services/logger.js";
import { NewerFormatError, UnreadableStoreError } from "@main/core/shared/storeFormat.js";
import { QuarantineError } from "@main/core/shared/quarantine.js";

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
  it.runIf(process.platform !== "win32")("leaves a future secret store permissions and bytes untouched", () => {
    const bytes = '{"formatVersion":99,"workspaces":{}}';
    fs.writeFileSync(keyFile, bytes, { mode: 0o644 });
    expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
    expect(() => writeApiKey(keyFile, W1, "anthropic", "key")).toThrow(NewerFormatError);
    expect(fs.readFileSync(keyFile, "utf8")).toBe(bytes);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o644);
  });

  it("writes, resolves, and clears a key; stores it obfuscated under the provider id, never plaintext", () => {
    expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
    expect(hasStoredApiKey(keyFile, W1, "anthropic")).toBe(false);

    writeApiKey(keyFile, W1, "anthropic", "sk-ant-secret");
    expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-ant-secret");
    expect(hasStoredApiKey(keyFile, W1, "anthropic")).toBe(true);

    const raw = fs.readFileSync(keyFile, "utf-8");
    expect(raw).not.toContain("sk-ant-secret"); // obfuscated, not plaintext
    // Nested: workspace -> keys -> provider id.
    expect(JSON.parse(raw)).toEqual({ formatVersion: 1, workspaces: { [W1]: { keys: { anthropic: expect.stringMatching(/^obf:/) } } } });

    writeApiKey(keyFile, W1, "anthropic", "");
    expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
    // The emptied workspace bucket leaves no trace.
    expect(JSON.parse(fs.readFileSync(keyFile, "utf-8"))).toEqual({ formatVersion: 1, workspaces: {} });
  });

  it("keeps keys independent across workspaces", () => {
    writeApiKey(keyFile, W1, "anthropic", "key-w1");
    writeApiKey(keyFile, W2, "anthropic", "key-w2");
    expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("key-w1");
    expect(resolveApiKey(keyFile, W2, "anthropic")).toBe("key-w2");

    writeApiKey(keyFile, W1, "anthropic", " ");
    expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
    expect(resolveApiKey(keyFile, W2, "anthropic")).toBe("key-w2");
  });

  it("clearWorkspaceKeys drops only that workspace's keys", () => {
    writeApiKey(keyFile, W1, "anthropic", "a");
    writeApiKey(keyFile, W2, "anthropic", "c");

    clearWorkspaceKeys(keyFile, W1);
    expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
    expect(resolveApiKey(keyFile, W2, "anthropic")).toBe("c");
    expect(JSON.parse(fs.readFileSync(keyFile, "utf-8")).workspaces[W1]).toBeUndefined();
  });

  it("hasStoredApiKey reports only a stored key, excluding the environment", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    expect(hasStoredApiKey(keyFile, W1, "anthropic")).toBe(false);
    writeApiKey(keyFile, W1, "anthropic", "stored");
    expect(hasStoredApiKey(keyFile, W1, "anthropic")).toBe(true);
    expect(hasStoredApiKey(keyFile, W2, "anthropic")).toBe(false);
  });

  it("hasEnvApiKey reflects the provider env var", () => {
    expect(hasEnvApiKey("anthropic")).toBe(false);
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect(hasEnvApiKey("anthropic")).toBe(true);
  });

  describe("environment-first resolution", () => {
    it("prefers a set env key over the stored one and never persists it", () => {
      writeApiKey(keyFile, W1, "anthropic", "sk-ant-stored");
      process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-ant-from-env");
      expect(fs.readFileSync(keyFile, "utf-8")).not.toContain("sk-ant-from-env");

      delete process.env.ANTHROPIC_API_KEY;
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-ant-stored");
    });

    it("trims the env value and ignores a blank one", () => {
      writeApiKey(keyFile, W1, "anthropic", "sk-ant-stored");
      process.env.ANTHROPIC_API_KEY = "  sk-trimmed  ";
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-trimmed");

      process.env.ANTHROPIC_API_KEY = "   ";
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-ant-stored"); // blank env → fall through
    });
  });

  describe("blank-key and whitespace handling", () => {
    it("treats a blank or whitespace written key as a removal", () => {
      writeApiKey(keyFile, W1, "anthropic", "sk-ant-secret");
      writeApiKey(keyFile, W1, "anthropic", "   ");
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
    });

    it("trims a stored key, so a leading/trailing-space key resolves trimmed", () => {
      writeApiKey(keyFile, W1, "anthropic", "  sk-spaced  ");
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-spaced");
    });

    it("does not create the file when clearing a key that was never set", () => {
      clearWorkspaceKeys(keyFile, W1);
      expect(fs.existsSync(keyFile)).toBe(false);
      writeApiKey(keyFile, W1, "anthropic", ""); // blank write on an absent key is also a no-op
      expect(fs.existsSync(keyFile)).toBe(false);
    });
  });

  describe("corrupt / hand-edited file tolerance", () => {
    it("reads a damaged file as holding no key and never moves it during a lookup", () => {
      fs.writeFileSync(keyFile, "{ not json");
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
      expect(hasStoredApiKey(keyFile, W1, "anthropic")).toBe(false);
      expect(keyFileProblem(keyFile)).toEqual({ key: "settings.keyFileDamaged", values: { path: keyFile } });
      expect(fs.readdirSync(dir)).toEqual(["api-keys.json"]);
      expect(fs.readFileSync(keyFile, "utf8")).toBe("{ not json");
    });

    it("sets a damaged file aside when a key is saved, starts a new one and says where the old one went", () => {
      fs.writeFileSync(keyFile, "{ not json");
      const movedTo = writeApiKey(keyFile, W1, "anthropic", "new-key");
      // Preserved aside under the derived-filename grammar: <stem>-<millisecond UTC
      // stamp>.invalid — never the full "api-keys.json" name with ".invalid" dot-appended.
      expect(path.basename(movedTo!)).toMatch(/^api-keys-\d{8}-\d{6}-utc\.invalid$/);
      expect(fs.readFileSync(movedTo!, "utf8")).toBe("{ not json");
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("new-key");
      expect(keyFileProblem(keyFile)).toBeNull();
    });

    it("leaves a damaged file in place when a workspace is removed", () => {
      fs.writeFileSync(keyFile, "{ not json");
      clearWorkspaceKeys(keyFile, W1);
      expect(fs.readdirSync(dir)).toEqual(["api-keys.json"]);
    });

    it("never moves or writes a file it could not read, and refuses saving into it", () => {
      // A directory where the file should be fails the read itself, as a permission error does.
      fs.mkdirSync(keyFile);
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
      expect(keyFileProblem(keyFile)).toEqual({ key: "settings.keyFileInaccessible", values: { path: keyFile } });
      expect(() => writeApiKey(keyFile, W1, "anthropic", "new-key")).toThrow(UnreadableStoreError);
      clearWorkspaceKeys(keyFile, W1);
      expect(fs.statSync(keyFile).isDirectory()).toBe(true);
      expect(fs.readdirSync(dir)).toEqual(["api-keys.json"]);
    });

    it("ignores a non-string entry and treats an untagged value as plaintext", () => {
      fs.writeFileSync(
        keyFile,
        JSON.stringify({
          formatVersion: 1,
          workspaces: {
            [W1]: { keys: { anthropic: 123 } },
            [W2]: { keys: { anthropic: "real-pasted" } },
          },
        }),
      );
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull(); // bad entry → absent
      expect(resolveApiKey(keyFile, W2, "anthropic")).toBe("real-pasted"); // untagged → plaintext
    });

    it("treats a workspaces key of the wrong shape as a damaged file", () => {
      const wrongShape = '{"formatVersion":1,"workspaces":[],"future":"keep me"}\n';
      fs.writeFileSync(keyFile, wrongShape);
      expect(keyFileProblem(keyFile)).toMatchObject({ key: "settings.keyFileDamaged" });
      const movedTo = writeApiKey(keyFile, W1, "anthropic", "new-key");
      expect(fs.readFileSync(movedTo!, "utf8")).toBe(wrongShape);
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("new-key");
    });

    it("ignores a workspace entry of another shape and keeps it when another workspace's key is written", () => {
      const other = { configs: { c1: { keys: { anthropic: "obf:x" } } } };
      fs.writeFileSync(keyFile, JSON.stringify({ formatVersion: 1, workspaces: { [W1]: other, [W2]: { keys: { anthropic: "kept" } } } }));
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
      expect(resolveApiKey(keyFile, W2, "anthropic")).toBe("kept");
      expect(keyFileProblem(keyFile)).toBeNull();

      expect(writeApiKey(keyFile, W2, "anthropic", "changed")).toBeNull();
      const stored = JSON.parse(fs.readFileSync(keyFile, "utf8"));
      expect(stored.workspaces[W1]).toEqual(other);
      expect(resolveApiKey(keyFile, W2, "anthropic")).toBe("changed");
      expect(fs.readdirSync(dir)).toEqual(["api-keys.json"]);
    });

    it("resolves a malformed obf: value as absent and warns naming the key, rather than passing decoded garbage to the provider", () => {
      // Buffer.from(..., "base64") silently drops characters outside the
      // alphabet instead of rejecting them, so an unvalidated decode of this
      // value would produce non-empty garbage that passes a truthiness check.
      fs.writeFileSync(
        keyFile,
        JSON.stringify({
          formatVersion: 1,
          workspaces: {
            [W1]: { keys: { anthropic: "obf:!!!not-base64!!!" } },
          },
        }),
      );
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [message, fields] = warnSpy.mock.calls[0]!;
        expect(message).toMatch(/invalid obf: encoding/);
        expect(fields).toEqual({ workspaceId: W1, key: "anthropic" });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("round-trips a validly stored key unchanged, with no warning", () => {
      writeApiKey(keyFile, W1, "anthropic", "sk-ant-real-key");
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-ant-real-key");
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

describe("file permissions (POSIX only)", () => {
  it.runIf(process.platform !== "win32")("creates the secrets file 0600", () => {
    writeApiKey(keyFile, W1, "anthropic", "sk-ant-secret");
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")("tightens a group/world-readable file back to 0600 on read", () => {
    writeApiKey(keyFile, W1, "anthropic", "sk-ant-secret");
    fs.chmodSync(keyFile, 0o644);
    resolveApiKey(keyFile, W1, "anthropic");
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  describe("format version", () => {
    it("reads a file without its format version as this build's format", () => {
      fs.writeFileSync(keyFile, JSON.stringify({ workspaces: { [W1]: { keys: { anthropic: "sk-plain" } } } }));
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-plain");
      expect(keyFileProblem(keyFile)).toBeNull();
    });

    it("writes this build's format version first and reads the key back", () => {
      writeApiKey(keyFile, W1, "anthropic", "sk-round-trip");
      expect(Object.keys(JSON.parse(fs.readFileSync(keyFile, "utf-8")))).toEqual(["formatVersion", "workspaces"]);
      expect(resolveApiKey(keyFile, W1, "anthropic")).toBe("sk-round-trip");
    });

    it("reads a file a newer version wrote as no key, refuses to store into it, and leaves it byte-identical", () => {
      const body = JSON.stringify({ formatVersion: 2, vaults: { [W1]: { anthropic: "obf:c2stZnV0dXJl" } } });
      fs.writeFileSync(keyFile, body);
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(resolveApiKey(keyFile, W1, "anthropic")).toBeNull();
        expect(hasStoredApiKey(keyFile, W1, "anthropic")).toBe(false);
        expect(() => writeApiKey(keyFile, W1, "anthropic", "sk-new")).toThrow(NewerFormatError);
        clearWorkspaceKeys(keyFile, W1);

        expect(fs.readFileSync(keyFile, "utf-8")).toBe(body);
        expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".invalid"))).toEqual([]);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("a damaged file that cannot be moved aside", () => {
    it("refuses the key save and is never written over", () => {
      const body = "{ not json";
      fs.writeFileSync(keyFile, body);
      const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      });
      try {
        expect(() => writeApiKey(keyFile, W1, "anthropic", "sk-new")).toThrow(QuarantineError);
      } finally {
        rename.mockRestore();
      }
      expect(fs.readFileSync(keyFile, "utf-8")).toBe(body);
    });
  });
});
