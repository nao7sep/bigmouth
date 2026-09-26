import { Fragment, createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from "react";
import { isLanguage, type Language } from "@shared/i18n/languages";
import { createTranslator as createTextTranslator, type Translator as TextTranslator } from "@shared/i18n/translate";
import type { MessageKey } from "@shared/i18n/catalogues";

// The renderer's translator: the shared one, plus rich text, whose
// placeholders may be filled with markup (a <code> path, say).
export type Translator = TextTranslator & {
  rich: (key: MessageKey, values: Record<string, ReactNode>) => ReactNode;
};

export function createTranslator(language: Language, locale: string = language): Translator {
  const base = createTextTranslator(language, locale);
  return {
    ...base,
    rich: (key, values) =>
      base.segments(key).map((segment, index) =>
        "text" in segment
          ? segment.text
          : createElement(
              Fragment,
              { key: index },
              segment.placeholder in values ? values[segment.placeholder] : `{${segment.placeholder}}`,
            ),
      ),
  };
}

// English until a provider says otherwise, so a component rendered on its own
// (in a test, say) still has text.
const I18nContext = createContext<Translator>(createTranslator("en"));

export function I18nProvider({
  language,
  locale,
  children,
}: {
  language: Language;
  locale: string;
  children: ReactNode;
}) {
  const translator = useMemo(() => createTranslator(language, locale), [language, locale]);

  // <html lang> picks the right glyphs for Chinese, Japanese and Korean text and
  // tells the last-resort error boundary, which sits outside this provider,
  // which language to speak.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useI18n(): Translator {
  return useContext(I18nContext);
}

// For surfaces outside the provider: the language the document last declared.
export function documentTranslator(): Translator {
  const declared = document.documentElement.lang;
  return createTranslator(isLanguage(declared) ? declared : "en");
}
