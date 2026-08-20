import { describe, it, expect } from "vitest";
import type { Settings } from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { firstSettingsError, settingsFieldErrors } from "@shared/settingsValidation";

function settings(over: Partial<Settings> = {}): Settings {
  return {
    timezone: "UTC",
    supportedLanguages: ["en", "ja"],
    publishedPostsPerLoad: 50,
    maxUploadMb: 500,
    editorWatermark: "",
    extraFieldWatermark: "",
    uiFontFamily: "",
    contentFont: { ...DEFAULT_CONTENT_FONT },
    ...over,
  };
}

describe("settings value rules", () => {
  it("passes a valid settings object with no messages at all", () => {
    expect(settingsFieldErrors(settings())).toEqual({});
    expect(firstSettingsError(settings())).toBeNull();
  });

  // The three sites had already drifted apart, each in a different direction.
  // These are the exact disagreements.
  it("rejects a fractional maxUploadMb, which the boundary used to accept", () => {
    // The UI said "integer >= 1"; the boundary said "> 0", so 0.5 was refused on
    // screen and accepted on the wire.
    expect(settingsFieldErrors(settings({ maxUploadMb: 0.5 }))).toHaveProperty("maxUploadMb");
    expect(settingsFieldErrors(settings({ maxUploadMb: 0 }))).toHaveProperty("maxUploadMb");
    expect(settingsFieldErrors(settings({ maxUploadMb: 1 }))).not.toHaveProperty("maxUploadMb");
  });

  it("rejects an empty language list and a non-two-letter code, which the boundary used to accept", () => {
    // The boundary said "any array of strings".
    expect(settingsFieldErrors(settings({ supportedLanguages: [] }))).toHaveProperty("supportedLanguages");
    expect(settingsFieldErrors(settings({ supportedLanguages: ["eng"] }))).toHaveProperty("supportedLanguages");
    expect(settingsFieldErrors(settings({ supportedLanguages: ["EN"] }))).toHaveProperty("supportedLanguages");
  });

  it("accepts duplicate languages, because the store folds them away on save", () => {
    // Commit-time cleanup, not a mistake to refuse — and the modal used to block
    // Save on it while the store quietly de-duplicated.
    expect(settingsFieldErrors(settings({ supportedLanguages: ["en", "en"] }))).toEqual({});
  });

  it("rejects a timezone the platform cannot resolve, which the boundary used to accept", () => {
    // The boundary said "non-empty string".
    expect(settingsFieldErrors(settings({ timezone: "Mars/Olympus" }))).toHaveProperty("timezone");
    expect(settingsFieldErrors(settings({ timezone: "   " }))).toHaveProperty("timezone");
    expect(settingsFieldErrors(settings({ timezone: "Asia/Tokyo" }))).not.toHaveProperty("timezone");
  });

  it("names the content-font fields by their path, so a boundary error says which one", () => {
    const font = { ...DEFAULT_CONTENT_FONT, size: 999, lineHeight: 0.1, padding: -1 };
    const errors = settingsFieldErrors(settings({ contentFont: font }));

    expect(Object.keys(errors).sort()).toEqual([
      "contentFont.lineHeight",
      "contentFont.padding",
      "contentFont.size",
    ]);
    expect(firstSettingsError(settings({ contentFont: font }))?.field).toBe("contentFont.size");
  });

  it("reports every offending field at once, not just the first", () => {
    // The modal renders a message beside each input, so it needs them all; the
    // boundary takes the first. One source, two readings.
    const errors = settingsFieldErrors(settings({ timezone: "", maxUploadMb: 0 }));
    expect(Object.keys(errors).sort()).toEqual(["maxUploadMb", "timezone"]);
  });
});
