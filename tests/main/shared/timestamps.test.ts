import { describe, it, expect } from "vitest";
import {
  formatForFilename,
  formatUtcIso,
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
