import { describe, it, expect } from "vitest";
import { isPostId, postFileName } from "@main/core/shared/filenames.js";

const ts = new Date("2026-04-05T14:30:22Z");

describe("postFileName", () => {
  it("is {createdAtUtc}-{id}.md", () => {
    expect(postFileName(ts, "V1StGXR8_Z5jD")).toBe(
      "20260405-143022-utc-V1StGXR8_Z5jD.md"
    );
  });

  it("is stable for the same inputs", () => {
    expect(postFileName(ts, "abc123")).toBe(postFileName(ts, "abc123"));
  });
});

describe("isPostId", () => {
  it("accepts the nanoid alphabet", () => {
    expect(isPostId("V1StGXR8_Z5jD")).toBe(true);
    expect(isPostId("a-b_C9")).toBe(true);
  });

  it("refuses anything that could name a path, and non-strings", () => {
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", "a.b", "a b", 42, null, undefined]) {
      expect(isPostId(bad)).toBe(false);
    }
  });
});
