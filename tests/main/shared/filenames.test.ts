import { describe, it, expect } from "vitest";
import { postFileName } from "../../src/../src/shared/filenames.js";

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
