import { describe, expect, it } from "vitest";
import { MASK, maskCredentials } from "@main/core/ai/maskCredentials.js";

const KEY = "sk-ant-fake-0123456789abcdef";

describe("maskCredentials", () => {
  it("masks credential headers whatever their case, keeping an Authorization scheme", () => {
    const masked = maskCredentials({
      headers: { "X-Api-Key": KEY, authorization: `Bearer ${KEY}`, cookie: "session=1", "content-type": "application/json" },
    }, []);
    expect(masked).toEqual({
      headers: { "X-Api-Key": MASK, authorization: `Bearer ${MASK}`, cookie: MASK, "content-type": "application/json" },
    });
  });

  it("replaces the key wherever a string holds it, keeping the structure", () => {
    const value = { error: { message: `bad key ${KEY}.`, nested: [KEY, 3, null] }, ok: true };
    expect(maskCredentials(value, [KEY])).toEqual({ error: { message: `bad key ${MASK}.`, nested: [MASK, 3, null] }, ok: true });
  });

  it("leaves the value it was given untouched", () => {
    const value = { headers: { "x-api-key": KEY } };
    maskCredentials(value, [KEY]);
    expect(value.headers["x-api-key"]).toBe(KEY);
  });

  it("ignores a missing or implausibly short key, and survives a cycle", () => {
    const cyclic: Record<string, unknown> = { word: "abc" };
    cyclic.self = cyclic;
    const masked = maskCredentials(cyclic, [null, undefined, "abc"]) as Record<string, unknown>;
    expect(masked.word).toBe("abc");
    expect(masked.self).toBe(masked);
  });
});
