/**
 * The interface language, as the main process holds it.
 *
 * The main process draws text of its own — the application menu, the edit
 * context menu, message dialogs, the startup-failure notice — and tells the
 * renderer which language the window speaks, so both halves always agree. It
 * reads the same catalogues as the renderer (@shared/i18n).
 *
 * The computer's languages are read once, at launch; System resolves against
 * that reading for the whole session.
 */

import { app, BrowserWindow } from "electron";

import { CHANNELS } from "@shared/ipc";
import {
  effectiveLanguage,
  formattingLocale,
  systemLanguage,
  type InterfaceLanguage,
  type Language,
  type LanguagePreference,
} from "@shared/i18n/languages";
import { createTranslator, type Translator } from "@shared/i18n/translate";

let computerLanguage: Language = "en";
let computerLocale: string | null = null;
let current: InterfaceLanguage = { language: "en", locale: "en" };
let translator: Translator = createTranslator("en");

function settle(preference: LanguagePreference): boolean {
  const language = effectiveLanguage(preference, computerLanguage);
  const locale = formattingLocale(language, computerLocale);
  const changed = language !== current.language || locale !== current.locale;
  current = { language, locale };
  translator = createTranslator(language, locale);
  return changed;
}

/**
 * Reads the computer's languages and regional format. Runs once, when the app
 * is ready and before anything is drawn, so even a startup failure speaks the
 * computer's language.
 */
export function detectComputerLanguage(): void {
  computerLanguage = systemLanguage(app.getPreferredSystemLanguages());
  computerLocale = app.getSystemLocale() || null;
  settle("system");
}

/** Applies the saved choice at launch; nothing is drawn yet. */
export function applyLanguagePreference(preference: LanguagePreference): void {
  settle(preference);
}

/**
 * Applies a choice saved in Settings: every window is told, and `onChanged`
 * redraws what the main process draws (the application menu). Returns whether
 * the language changed.
 */
export function changeLanguagePreference(preference: LanguagePreference, onChanged: () => void): boolean {
  if (!settle(preference)) return false;
  onChanged();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(CHANNELS.interfaceLanguageChanged, current);
    }
  }
  return true;
}

/** The language the window speaks and the locale it formats in. */
export function interfaceLanguage(): InterfaceLanguage {
  return current;
}

/** The translator for text the main process draws. */
export function mainTranslator(): Translator {
  return translator;
}
