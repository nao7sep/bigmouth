import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveApiKey, hasApiKey, writeApiKey, clearApiKey } from "@main/core/services/apiKeys.js";

let dir: string;
let keyFile: string;
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
  it("writes, resolves, and clears a key by config id; never stores plaintext", () => {
    expect(resolveApiKey(keyFile, "c1", "claude")).toBeNull();
    expect(hasApiKey(keyFile, "c1", "claude")).toBe(false);

    writeApiKey(keyFile, "c1", "sk-ant-secret");
    expect(resolveApiKey(keyFile, "c1", "claude")).toBe("sk-ant-secret");
    expect(hasApiKey(keyFile, "c1", "claude")).toBe(true);
    expect(fs.readFileSync(keyFile, "utf-8")).not.toContain("sk-ant-secret"); // obfuscated, not plaintext

    clearApiKey(keyFile, "c1");
    expect(resolveApiKey(keyFile, "c1", "claude")).toBeNull();
  });

  it("keeps keys independent per config id", () => {
    writeApiKey(keyFile, "c1", "key-one");
    writeApiKey(keyFile, "c2", "key-two");
    expect(resolveApiKey(keyFile, "c1", "claude")).toBe("key-one");
    expect(resolveApiKey(keyFile, "c2", "claude")).toBe("key-two");

    clearApiKey(keyFile, "c1");
    expect(resolveApiKey(keyFile, "c1", "claude")).toBeNull();
    expect(resolveApiKey(keyFile, "c2", "claude")).toBe("key-two"); // the other key is untouched
  });

  it("prefers the environment key over the stored one and never persists it", () => {
    writeApiKey(keyFile, "c1", "sk-ant-stored");
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-env";
    expect(resolveApiKey(keyFile, "c1", "claude")).toBe("sk-ant-from-env");
    expect(fs.readFileSync(keyFile, "utf-8")).not.toContain("sk-ant-from-env");

    delete process.env.ANTHROPIC_API_KEY;
    expect(resolveApiKey(keyFile, "c1", "claude")).toBe("sk-ant-stored");
  });

  it("treats an empty written key as a removal", () => {
    writeApiKey(keyFile, "c1", "sk-ant-secret");
    writeApiKey(keyFile, "c1", "");
    expect(resolveApiKey(keyFile, "c1", "claude")).toBeNull();
  });
});

it.runIf(process.platform !== "win32")("writes the secrets file with 0600 permissions", () => {
  writeApiKey(keyFile, "c1", "sk-ant-secret");
  expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
});
