import { describe, it, expect } from "vitest";
import { formatLocalDateTime, isValidTimeZone } from "@renderer/util/timestamps";

// Display formatting takes an explicit IANA zone, so its output depends on the
// passed zone, never on the host machine's local zone.

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

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
