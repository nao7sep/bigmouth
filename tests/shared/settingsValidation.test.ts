import { describe, it, expect } from "vitest";
import type { Settings } from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { firstSettingsError, numberFieldValue, settingsFieldErrors } from "@shared/settingsValidation";

function settings(over: Partial<Settings> = {}): Settings {
  return {
    timezone: "UTC",
    supportedLanguages: ["en", "ja"],
    postsPerLoad: 50,
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
  it("rejects a fractional postsPerLoad, as the boundary once failed to", () => {
    // The UI said "integer >= 1"; the boundary said "> 0", so 0.5 was refused on
    // screen and accepted on the wire.
    expect(settingsFieldErrors(settings({ postsPerLoad: 0.5 }))).toHaveProperty("postsPerLoad");
    expect(settingsFieldErrors(settings({ postsPerLoad: 0 }))).toHaveProperty("postsPerLoad");
    expect(settingsFieldErrors(settings({ postsPerLoad: 1 }))).not.toHaveProperty("postsPerLoad");
  });

  it("rejects an empty language list and a non-two-letter code, which the boundary used to accept", () => {
    // The boundary said "any array of strings".
    expect(settingsFieldErrors(settings({ supportedLanguages: [] }))).toHaveProperty("supportedLanguages");
    expect(settingsFieldErrors(settings({ supportedLanguages: ["eng"] }))).toHaveProperty("supportedLanguages");
    expect(settingsFieldErrors(settings({ supportedLanguages: ["EN"] }))).toHaveProperty("supportedLanguages");
  });

  it("accepts duplicate languages, because the store folds them away on save", () => {
    // Commit-time cleanup, not a mistake to refuse: the store de-duplicates on
    // save, so blocking Save on it would ask the user to fix nothing.
    expect(settingsFieldErrors(settings({ supportedLanguages: ["en", "en"] }))).toEqual({});
  });

  it("rejects a timezone the platform cannot resolve, which the boundary used to accept", () => {
    // The boundary said "non-empty string".
    expect(settingsFieldErrors(settings({ timezone: "Mars/Olympus" }))).toHaveProperty("timezone");
    expect(settingsFieldErrors(settings({ timezone: "   " }))).toHaveProperty("timezone");
    expect(settingsFieldErrors(settings({ timezone: "Asia/Tokyo" }))).not.toHaveProperty("timezone");
  });

  it("accepts System, which follows the computer's zone", () => {
    expect(settingsFieldErrors(settings({ timezone: "system" }))).not.toHaveProperty("timezone");
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

  it("takes whole numbers only for font size and padding, and any number in range for line height", () => {
    const errors = (font: Partial<Settings["contentFont"]>) =>
      Object.keys(settingsFieldErrors(settings({ contentFont: { ...DEFAULT_CONTENT_FONT, ...font } })));
    expect(errors({ size: 12.5, padding: 3.5 }).sort()).toEqual(["contentFont.padding", "contentFont.size"]);
    expect(errors({ size: 8, padding: 0, lineHeight: 1.25 })).toEqual([]);
    expect(errors({ size: Number.NaN, padding: Number.NaN, lineHeight: Number.NaN }).sort())
      .toEqual(["contentFont.lineHeight", "contentFont.padding", "contentFont.size"]);
  });

  it("names the language code that fails its check", () => {
    expect(settingsFieldErrors(settings({ supportedLanguages: ["en", "EN", "ja"] })).supportedLanguages)
      .toEqual({ key: "settings.languageCodeInvalid", values: { code: "EN" } });
  });

  it("reads a number field's text whole, never its leading digits", () => {
    expect(numberFieldValue("12")).toBe(12);
    expect(numberFieldValue("1.25")).toBe(1.25);
    expect(numberFieldValue("")).toBeNaN();
    expect(numberFieldValue("  ")).toBeNaN();
    expect(numberFieldValue("12px")).toBeNaN();
  });

  it("reports every offending field at once, not just the first", () => {
    // The modal renders a message beside each input, so it needs them all; the
    // boundary takes the first. One source, two readings.
    const errors = settingsFieldErrors(settings({ timezone: "", postsPerLoad: 0 }));
    expect(Object.keys(errors).sort()).toEqual(["postsPerLoad", "timezone"]);
  });
});
