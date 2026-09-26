import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterfaceLanguage } from "@shared/i18n/languages";
import { useI18n } from "@renderer/i18n/I18nContext";
import { InterfaceLanguageRoot } from "@renderer/i18n/InterfaceLanguageRoot";

function Probe() {
  const { t } = useI18n();
  return <p>{t("common.cancel")}</p>;
}

afterEach(() => {
  document.documentElement.lang = "en";
  vi.unstubAllGlobals();
});

describe("InterfaceLanguageRoot", () => {
  it("speaks the language main settled on and follows a newly saved one", () => {
    let listener: ((language: InterfaceLanguage) => void) | null = null;
    const unsubscribe = vi.fn();
    vi.stubGlobal("bigmouth", {
      onInterfaceLanguageChanged: (next: (language: InterfaceLanguage) => void) => {
        listener = next;
        return unsubscribe;
      },
    });

    const { getByText, unmount } = render(
      <InterfaceLanguageRoot initial={{ language: "de", locale: "de-DE" }}>
        <Probe />
      </InterfaceLanguageRoot>,
    );
    expect(getByText("Abbrechen")).toBeTruthy();
    expect(document.documentElement.lang).toBe("de");

    act(() => listener!({ language: "ja", locale: "ja-JP" }));
    expect(getByText("キャンセル")).toBeTruthy();
    expect(document.documentElement.lang).toBe("ja");

    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
