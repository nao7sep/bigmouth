import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  preferred: ["ko-KR", "en-US"],
  systemLocale: "ko-KR",
  sent: [] as unknown[][],
  // Calls into the app's own defaults domain and reads of the computer's
  // languages, in order.
  defaults: [] as unknown[][],
  failWrite: false,
  warnings: [] as unknown[][],
}));

vi.mock("@main/core/services/logger.js", () => ({
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
  warn: (...args: unknown[]) => electron.warnings.push(args),
}));

vi.mock("electron", () => ({
  app: {
    getPreferredSystemLanguages: () => {
      electron.defaults.push(["read"]);
      return electron.preferred;
    },
    getSystemLocale: () => electron.systemLocale,
  },
  systemPreferences: {
    setUserDefault: (...args: unknown[]) => {
      if (electron.failWrite) throw new Error("defaults unavailable");
      electron.defaults.push(["set", ...args]);
    },
    removeUserDefault: (...args: unknown[]) => electron.defaults.push(["remove", ...args]),
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
  electron.defaults.length = 0;
  electron.failWrite = false;
  electron.warnings.length = 0;
});

function onPlatform(platform: NodeJS.Platform, body: () => Promise<void>) {
  return async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      await body();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  };
}

describe("AppKit's language entry", () => {
  it("holds the chosen language alone, and no entry under System", async () => {
    const { appKitLanguages } = await freshI18n();
    expect(appKitLanguages("system")).toBeNull();
    expect(appKitLanguages("ja")).toEqual(["ja"]);
    expect(appKitLanguages("zh-Hans")).toEqual(["zh-Hans"]);
    expect(appKitLanguages("pt-BR")).toEqual(["pt-BR"]);
  });

  it("removes the app's entry before reading the computer's languages, then writes the choice", onPlatform("darwin", async () => {
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    i18n.applyLanguagePreference("fr");
    expect(electron.defaults).toEqual([
      ["remove", "AppleLanguages"],
      ["read"],
      ["set", "AppleLanguages", "array", ["fr"]],
    ]);
    // The computer's own language still decides System for this session.
    i18n.changeLanguagePreference("system", () => {});
    expect(i18n.interfaceLanguage().language).toBe("ko");
  }));

  it("removes the entry when the saved choice is System", onPlatform("darwin", async () => {
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    electron.defaults.length = 0;
    i18n.applyLanguagePreference("system");
    expect(electron.defaults).toEqual([["remove", "AppleLanguages"]]);
  }));

  it("writes a choice saved mid-session even when this session's language stays", onPlatform("darwin", async () => {
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    i18n.applyLanguagePreference("system");
    electron.defaults.length = 0;
    const redraw = vi.fn();
    expect(i18n.changeLanguagePreference("ko", redraw)).toBe(false);
    expect(redraw).not.toHaveBeenCalled();
    expect(electron.defaults).toEqual([["set", "AppleLanguages", "array", ["ko"]]]);
    i18n.changeLanguagePreference("system", redraw);
    expect(electron.defaults.at(-1)).toEqual(["remove", "AppleLanguages"]);
  }));

  it("logs a failed write and still applies the language", onPlatform("darwin", async () => {
    electron.failWrite = true;
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    i18n.applyLanguagePreference("de");
    expect(i18n.interfaceLanguage().language).toBe("de");
    expect(electron.warnings).toHaveLength(1);
  }));

  it("touches no defaults outside macOS", onPlatform("win32", async () => {
    const i18n = await freshI18n();
    i18n.detectComputerLanguage();
    i18n.applyLanguagePreference("fr");
    i18n.changeLanguagePreference("system", () => {});
    expect(electron.defaults).toEqual([["read"]]);
  }));
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
