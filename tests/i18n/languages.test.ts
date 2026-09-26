import { describe, expect, it } from "vitest";
import {
  effectiveLanguage,
  formattingLocale,
  normalizeLanguagePreference,
  systemLanguage,
} from "@shared/i18n/languages";

describe("normalizeLanguagePreference", () => {
  it("keeps System and every supported tag", () => {
    expect(normalizeLanguagePreference("system")).toBe("system");
    expect(normalizeLanguagePreference("ja")).toBe("ja");
    expect(normalizeLanguagePreference("zh-Hans")).toBe("zh-Hans");
    expect(normalizeLanguagePreference("pt-BR")).toBe("pt-BR");
  });

  it("follows the computer for anything missing, retired, or hand-edited", () => {
    expect(normalizeLanguagePreference(undefined)).toBe("system");
    expect(normalizeLanguagePreference("zh-hans")).toBe("system");
    expect(normalizeLanguagePreference("pt")).toBe("system");
    expect(normalizeLanguagePreference(3)).toBe("system");
  });
});

describe("effectiveLanguage", () => {
  it("resolves System to the computer's language and keeps an explicit choice", () => {
    expect(effectiveLanguage("system", "ko")).toBe("ko");
    expect(effectiveLanguage("fr", "ko")).toBe("fr");
  });
});

describe("formattingLocale", () => {
  it("uses the computer's regional locale when it is in the interface language", () => {
    expect(formattingLocale("en", "en-GB")).toBe("en-GB");
    expect(formattingLocale("pt-BR", "pt-PT")).toBe("pt-PT");
    expect(formattingLocale("zh-Hans", "zh-CN")).toBe("zh-CN");
  });

  it("uses the interface language's own format otherwise", () => {
    expect(formattingLocale("de", "en-GB")).toBe("de");
    expect(formattingLocale("zh-Hans", "zh-TW")).toBe("zh-Hans");
    expect(formattingLocale("en", null)).toBe("en");
    expect(formattingLocale("en", "not a locale")).toBe("en");
  });
});

describe("systemLanguage", () => {
  it("takes the first of the computer's languages that the app speaks", () => {
    expect(systemLanguage(["nl-NL", "de-AT", "en-US"])).toBe("de");
    expect(systemLanguage(["es-419"])).toBe("es");
    expect(systemLanguage(["ko"])).toBe("ko");
  });

  it("resolves every Chinese and Portuguese locale to the one variety shipped", () => {
    expect(systemLanguage(["zh-Hant-TW"])).toBe("zh-Hans");
    expect(systemLanguage(["zh-HK"])).toBe("zh-Hans");
    expect(systemLanguage(["zh_CN"])).toBe("zh-Hans");
    expect(systemLanguage(["pt-PT"])).toBe("pt-BR");
  });

  it("speaks English when none of the computer's languages is in the set", () => {
    expect(systemLanguage(["nl-NL", "sv"])).toBe("en");
    expect(systemLanguage([])).toBe("en");
  });
});
