import { describe, it, expect } from "vitest";
import { formatLocalDateTime } from "@renderer/util/timestamps";
import { createTranslator } from "@shared/i18n/translate";

// Display formatting takes an explicit IANA zone, so its output depends on the
// passed zone, never on the host machine's local zone, and on the interface
// language's own date format.

const english = createTranslator("en", "en-US").dateTime;

describe("formatLocalDateTime", () => {
  it("renders the instant in the given zone in the interface language's format", () => {
    // 05:30 UTC is 14:30 in Asia/Tokyo (+9).
    expect(formatLocalDateTime("2026-04-05T05:30:00.000Z", "Asia/Tokyo", english)).toBe("Apr 5, 2026, 2:30 PM");
    expect(formatLocalDateTime("2026-04-05T05:30:00.000Z", "Asia/Tokyo", createTranslator("ja").dateTime)).toBe(
      "2026/04/05 14:30",
    );
  });

  it("honors the passed zone rather than the host zone", () => {
    // The same instant is 01:30 in New York (EDT, -4) on 2026-04-05.
    expect(formatLocalDateTime("2026-04-05T05:30:00.000Z", "America/New_York", english)).toBe("Apr 5, 2026, 1:30 AM");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatLocalDateTime("not a date", "Asia/Tokyo", english)).toBe("");
  });
});
