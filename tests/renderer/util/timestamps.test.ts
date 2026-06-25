import { describe, it, expect } from "vitest";
import { compareInstants, formatLocalDateTime } from "../../src/util/timestamps";

// Display formatting is local-time. The suite runs under a fixed, DST-free zone
// (Asia/Tokyo, +9) pinned in vite.config.ts so this output is deterministic.

describe("compareInstants", () => {
  it("orders mixed-precision timestamps chronologically, not lexicographically", () => {
    // Lexicographically "…22.500Z" < "…22Z", but 22.000 < 22.500 chronologically.
    expect(compareInstants("2026-04-05T14:30:22Z", "2026-04-05T14:30:22.500Z")).toBeLessThan(0);
  });

  it("treats different string forms of the same instant as equal", () => {
    expect(compareInstants("2026-04-05T14:30:22Z", "2026-04-05T14:30:22.000Z")).toBe(0);
  });

  it("sorts an absent value earliest", () => {
    expect(compareInstants("", "2026-04-05T14:30:22.000Z")).toBeLessThan(0);
    expect(compareInstants("", "")).toBe(0);
  });
});

describe("formatLocalDateTime", () => {
  it("renders local time as yyyy-mm-dd HH:mm with no localization", () => {
    // 05:30 UTC is 14:30 in Asia/Tokyo (+9).
    expect(formatLocalDateTime("2026-04-05T05:30:00.000Z")).toBe("2026-04-05 14:30");
  });
});
