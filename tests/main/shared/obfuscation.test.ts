import { describe, it, expect } from "vitest";
import { obfuscate, deobfuscate } from "@main/core/shared/obfuscation.js";

describe("obfuscation round-trip", () => {
  it("recovers the original string", () => {
    const key = "sk-ant-api03-abcdefghijklmnop";
    expect(deobfuscate(obfuscate(key))).toBe(key);
  });

  // The contract is API keys, which are ASCII. Any UTF-8 string also round-trips:
  // the encoding reverses the raw bytes (an involution), so reversing twice
  // restores the original bytes exactly — code points and astral chars included.
  it("preserves BMP non-ASCII characters", () => {
    const value = "日本語のキー";
    expect(deobfuscate(obfuscate(value))).toBe(value);
  });

  it("maps empty string to empty string both ways", () => {
    expect(obfuscate("")).toBe("");
    expect(deobfuscate("")).toBe("");
  });

  it("does not store the key verbatim", () => {
    const key = "secret-api-key";
    const encoded = obfuscate(key);
    expect(encoded).not.toBe(key);
    expect(encoded).not.toContain(key);
  });
});
