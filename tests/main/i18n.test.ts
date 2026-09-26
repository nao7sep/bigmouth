import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  preferred: ["ko-KR", "en-US"],
  systemLocale: "ko-KR",
  sent: [] as unknown[][],
}));

vi.mock("electron", () => ({
  app: {
    getPreferredSystemLanguages: () => electron.preferred,
    getSystemLocale: () => electron.systemLocale,
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: (...args: unknown[]) => electron.sent.push(args) },
      },
    ],
  },
}));

async function freshI18n() {
  vi.resetModules();
  return import("@main/i18n");
}

beforeEach(() => {
  electron.preferred = ["ko-KR", "en-US"];
  electron.systemLocale = "ko-KR";
  electron.sent.length = 0;
});

describe("main-process interface language", () => {
  it("follows the computer's language and regional format under System", async () => {
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    i18n.applyLanguagePreference("system");
    expect(i18n.interfaceLanguage()).toEqual({ language: "ko", locale: "ko-KR" });
    expect(i18n.mainTranslator().t("common.cancel")).toBe("취소");
  });

  it("speaks a chosen language in that language's own format", async () => {
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    i18n.applyLanguagePreference("fr");
    expect(i18n.interfaceLanguage()).toEqual({ language: "fr", locale: "fr" });
  });

  it("tells every window and redraws the menu when a saved choice changes the language", async () => {
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    const redraw = vi.fn();
    expect(i18n.changeLanguagePreference("ko", redraw)).toBe(false);
    expect(redraw).not.toHaveBeenCalled();

    expect(i18n.changeLanguagePreference("de", redraw)).toBe(true);
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(electron.sent).toEqual([["i18n:changed", { language: "de", locale: "de" }]]);
  });

  it("speaks English on a computer whose languages are all outside the set", async () => {
    electron.preferred = ["nl-NL"];
    electron.systemLocale = "nl-NL";
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    expect(i18n.interfaceLanguage()).toEqual({ language: "en", locale: "en" });
  });
});
