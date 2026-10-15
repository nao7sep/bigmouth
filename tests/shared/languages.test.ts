import { describe, it, expect } from "vitest";
import { languageNameIn } from "@shared/i18n/languages";

// A System choice names the language it resolves to in the interface language.
describe("languageNameIn", () => {
  it("names a language in the reader's language", () => {
    expect(languageNameIn("en", "ja")).toBe("Japanese");
    expect(languageNameIn("ja", "ja")).toBe("日本語");
    expect(languageNameIn("de", "en")).toBe("Englisch");
  });
});
