import { describe, it, expect } from "vitest";
import { compareInstants, formatLocalDateTime } from "@renderer/util/timestamps";

// Display formatting takes an explicit IANA zone, so its output depends on the
// passed zone, never on the host machine's local zone.

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
  it("renders the instant in the given zone as yyyy-mm-dd HH:mm, no localization", () => {
    // 05:30 UTC is 14:30 in Asia/Tokyo (+9).
    expect(formatLocalDateTime("2026-04-05T05:30:00.000Z", "Asia/Tokyo")).toBe("2026-04-05 14:30");
  });

  it("honors the passed zone rather than the host zone", () => {
    // The same instant is 01:30 in New York (EDT, -4) on 2026-04-05.
    expect(formatLocalDateTime("2026-04-05T05:30:00.000Z", "America/New_York")).toBe("2026-04-05 01:30");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatLocalDateTime("not a date", "Asia/Tokyo")).toBe("");
  });
});
