import { useEffect, useState, type ReactNode } from "react";
import type { InterfaceLanguage } from "@shared/i18n/languages";
import { I18nProvider } from "./I18nContext";

// The window speaks the language the main process settled on, so it always
// agrees with the menus and dialogs main draws, and follows a new choice the
// moment Settings saves it.
export function InterfaceLanguageRoot({
  initial,
  children,
}: {
  initial: InterfaceLanguage;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState(initial);
  useEffect(() => window.bigmouth.onInterfaceLanguageChanged(setCurrent), []);
  return (
    <I18nProvider language={current.language} locale={current.locale}>
      {children}
    </I18nProvider>
  );
}
