import { describe, it, expect } from "vitest";
import {
  formatForFilename,
  formatForDisplay,
  formatForFrontMatter,
} from "../../src/../src/shared/timestamps.js";

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

describe("formatForFrontMatter", () => {
  it("emits an ISO 8601 UTC string without milliseconds", () => {
    const d = new Date("2026-04-05T14:30:22Z");
    expect(formatForFrontMatter(d)).toBe("2026-04-05T14:30:22Z");
  });

  it("strips a non-zero millisecond component", () => {
    const d = new Date("2026-04-05T14:30:22.123Z");
    expect(formatForFrontMatter(d)).toBe("2026-04-05T14:30:22Z");
  });
});

describe("formatForDisplay", () => {
  it("converts UTC to Asia/Tokyo (+9)", () => {
    const d = new Date("2026-04-05T14:30:22Z");
    // 14:30 UTC -> 23:30 JST, same date.
    expect(formatForDisplay(d, "Asia/Tokyo")).toBe(
      "2026-04-05 23:30:22 GMT+9"
    );
  });

  it("renders UTC unchanged", () => {
    const d = new Date("2026-04-05T14:30:22Z");
    expect(formatForDisplay(d, "UTC")).toBe("2026-04-05 14:30:22 UTC");
  });

  it("rolls the date forward when the timezone offset crosses midnight", () => {
    const d = new Date("2026-04-05T16:00:00Z");
    // 16:00 UTC -> 01:00 JST next day.
    expect(formatForDisplay(d, "Asia/Tokyo")).toBe(
      "2026-04-06 01:00:00 GMT+9"
    );
  });
});
