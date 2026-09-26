import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { MessageKey } from "@shared/i18n/catalogues";
import { createTranslator as createTextTranslator, message } from "@shared/i18n/translate";
import { createTranslator } from "@renderer/i18n/I18nContext";

describe("createTranslator", () => {
  it("fills placeholders", () => {
    expect(createTextTranslator("en").t("nativeMenu.about", { app: "BigMouth" })).toBe("About BigMouth");
    expect(createTextTranslator("ja").t("nativeMenu.quit", { app: "BigMouth" })).toBe("BigMouthを終了");
  });

  it("renders a message nested as a value in the same language", () => {
    const de = createTextTranslator("de");
    const text = de.t("dialog.unsavedMetadata.quitDetail", { refused: message("dialog.refusedMetadata.explanation") });
    expect(text.startsWith(de.t("dialog.refusedMetadata.explanation"))).toBe(true);
    expect(text).toContain("Trotzdem beenden");
  });

  it("renders a message descriptor", () => {
    expect(createTextTranslator("fr").text(message("common.cancel"))).toBe("Annuler");
  });

  it("formats numbers, percentages, lists and instants for the locale", () => {
    expect(createTextTranslator("en", "en-US").number(12345)).toBe("12,345");
    expect(createTextTranslator("de").number(12345)).toBe("12.345");
    expect(createTextTranslator("fr").percent(1.1)).toBe("110 %");
    expect(createTextTranslator("en", "en-US").list(["a", "b", "c"])).toBe("a, b, c");
    const instant = new Date("2026-04-05T05:30:00.000Z");
    expect(createTextTranslator("en", "en-US").dateTime(instant, "Asia/Tokyo")).toBe("Apr 5, 2026, 2:30 PM");
    expect(createTextTranslator("de").dateTime(instant, "America/New_York")).toBe("05.04.2026, 01:30");
  });

  it("puts markup into placeholders for rich text", () => {
    const parts = createTranslator("en").rich("nativeMenu.about", { app: "B" }) as unknown[];
    const filled = parts.map((part) =>
      isValidElement(part) ? (part as ReactElement<{ children: unknown }>).props.children : part,
    );
    expect(filled.join("")).toBe("About B");
  });

  it("shows a key the catalogue lacks instead of failing the render", () => {
    // Types keep this out of the app; a stale build or a half-merged catalogue
    // could still reach it, and a window must not go down over one string.
    const missing = "gone.missing" as unknown as MessageKey;
    expect(createTextTranslator("ja").t(missing)).toBe("gone.missing");
  });
});
