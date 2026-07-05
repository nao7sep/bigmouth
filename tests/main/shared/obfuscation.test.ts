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

describe("strict obf: decode", () => {
  it("returns null for a marked value whose payload is not valid base64", () => {
    // Buffer.from(..., "base64") is a tolerant decoder: it silently drops
    // characters outside the alphabet instead of rejecting them, so without a
    // strict pre-check this would decode to non-empty garbage rather than
    // being recognized as malformed.
    expect(deobfuscate("obf:!!!not-base64!!!")).toBeNull();
  });

  it("returns null for a payload whose length is not a multiple of 4", () => {
    expect(deobfuscate("obf:QQ")).toBeNull(); // valid alphabet, wrong length
  });

  it("returns null for a payload with invalid interior padding", () => {
    expect(deobfuscate("obf:Q=Q=")).toBeNull();
  });

  it("still decodes a valid obf: value unchanged (round-trip)", () => {
    const key = "sk-ant-valid-key";
    const encoded = obfuscate(key);
    expect(deobfuscate(encoded)).toBe(key);
  });

  it("still treats an untagged value as plaintext", () => {
    expect(deobfuscate("hand-pasted-key")).toBe("hand-pasted-key");
  });
});
