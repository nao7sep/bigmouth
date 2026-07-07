import { describe, it, expect } from "vitest";
import {
  formatForFilename,
  formatForFilenameMs,
  formatUtcIso,
  compareInstants,
} from "@main/core/shared/timestamps.js";

describe("formatForFilename", () => {
  it("formats a UTC date as yyyymmdd-hhmmss-utc", () => {
    const d = new Date("2026-04-05T14:30:22Z");
    expect(formatForFilename(d)).toBe("20260405-143022-utc");
  });

  it("zero-pads single-digit month, day, and time components", () => {
    const d = new Date("2026-01-02T03:04:05Z");
    expect(formatForFilename(d)).toBe("20260102-030405-utc");
  });

  it("uses UTC fields, not local time", () => {
    // Midnight UTC — would roll to a different date in non-UTC zones.
    const d = new Date("2026-12-31T23:59:59Z");
    expect(formatForFilename(d)).toBe("20261231-235959-utc");
  });
});

describe("formatForFilenameMs", () => {
  it("formats a UTC date as yyyymmdd-hhmmss-fff-utc", () => {
    const d = new Date("2026-06-10T03:15:42.123Z");
    expect(formatForFilenameMs(d)).toBe("20260610-031542-123-utc");
  });

  it("zero-pads a single/double-digit millisecond component", () => {
    expect(formatForFilenameMs(new Date("2026-01-02T03:04:05.007Z"))).toBe("20260102-030405-007-utc");
    expect(formatForFilenameMs(new Date("2026-01-02T03:04:05.070Z"))).toBe("20260102-030405-070-utc");
  });

  it("uses UTC fields, not local time", () => {
    const d = new Date("2026-12-31T23:59:59.999Z");
    expect(formatForFilenameMs(d)).toBe("20261231-235959-999-utc");
  });
});

describe("formatUtcIso", () => {
  it("emits canonical ISO 8601 UTC with exactly three fractional digits", () => {
    const d = new Date("2026-04-05T14:30:22Z");
    expect(formatUtcIso(d)).toBe("2026-04-05T14:30:22.000Z");
  });

  it("keeps a non-zero millisecond component", () => {
    const d = new Date("2026-04-05T14:30:22.123Z");
    expect(formatUtcIso(d)).toBe("2026-04-05T14:30:22.123Z");
  });
});

describe("compareInstants", () => {
  it("orders by the instant, ascending", () => {
    expect(compareInstants("2026-04-05T14:30:22.000Z", "2026-04-05T14:30:23.000Z")).toBeLessThan(0);
    expect(compareInstants("2026-04-05T14:30:23.000Z", "2026-04-05T14:30:22.000Z")).toBeGreaterThan(0);
    expect(compareInstants("2026-04-05T14:30:22.000Z", "2026-04-05T14:30:22.000Z")).toBe(0);
  });

  it("treats different string forms of the same instant as equal (parse-liberal)", () => {
    expect(compareInstants("2026-04-05T14:30:22Z", "2026-04-05T14:30:22.000Z")).toBe(0);
    expect(compareInstants("2026-04-05T14:30:22+00:00", "2026-04-05T14:30:22.000Z")).toBe(0);
  });

  it("orders mixed-precision timestamps chronologically, not lexicographically", () => {
    // Lexicographically "…22.500Z" < "…22Z" ('.' < 'Z'), but chronologically
    // 22.000 < 22.500 — the instant comparator must get this right.
    expect(compareInstants("2026-04-05T14:30:22Z", "2026-04-05T14:30:22.500Z")).toBeLessThan(0);
  });

  it("sorts an absent/unparseable value earliest", () => {
    expect(compareInstants("", "2026-04-05T14:30:22.000Z")).toBeLessThan(0);
    expect(compareInstants("2026-04-05T14:30:22.000Z", "")).toBeGreaterThan(0);
    expect(compareInstants("", "")).toBe(0);
  });
});
