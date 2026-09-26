import { describe, expect, it } from "vitest";
import {
  SYSTEM_TIME_ZONE,
  effectiveTimeZone,
  isValidTimeZone,
  normalizeTimeZonePreference,
  systemTimeZone,
  timeZoneOptions,
} from "@shared/timeZone";

describe("isValidTimeZone", () => {
  it("accepts real IANA zones and rejects junk", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("normalizeTimeZonePreference", () => {
  it("keeps System and every zone the runtime resolves", () => {
    expect(normalizeTimeZonePreference("system")).toBe(SYSTEM_TIME_ZONE);
    expect(normalizeTimeZonePreference("Europe/Berlin")).toBe("Europe/Berlin");
  });

  it("follows the computer for anything missing, empty, or unknown", () => {
    expect(normalizeTimeZonePreference(undefined)).toBe(SYSTEM_TIME_ZONE);
    expect(normalizeTimeZonePreference("")).toBe(SYSTEM_TIME_ZONE);
    expect(normalizeTimeZonePreference("Mars/Olympus")).toBe(SYSTEM_TIME_ZONE);
    expect(normalizeTimeZonePreference(9)).toBe(SYSTEM_TIME_ZONE);
  });
});

describe("effectiveTimeZone", () => {
  it("resolves System to the computer's zone on every call and keeps a chosen zone", () => {
    expect(effectiveTimeZone("system")).toBe(systemTimeZone());
    expect(effectiveTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
  });
});

describe("timeZoneOptions", () => {
  it("lists the platform's zones sorted, with UTC, and never System itself", () => {
    const zones = timeZoneOptions("system");
    expect(zones).toContain("UTC");
    expect(zones).toContain("Asia/Tokyo");
    expect(zones).not.toContain("system");
    expect([...zones].sort()).toEqual(zones);
  });

  it("keeps a saved zone selectable even when the platform list lacks it", () => {
    // An alias the runtime resolves but does not list as canonical.
    expect(timeZoneOptions("Asia/Calcutta")).toContain("Asia/Calcutta");
  });
});
