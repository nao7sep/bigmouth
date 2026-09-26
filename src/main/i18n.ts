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

import { app, BrowserWindow, systemPreferences } from "electron";

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
import { serializeError, warn } from "./core/services/logger.js";

// macOS draws some Edit menu items itself (Emoji & Symbols, Start Dictation,
// AutoFill, Writing Tools, Services) in the language AppKit settles on from
// AppleLanguages before any JavaScript runs. Electron offers no volatile
// argument domain, so the interface language is kept as AppleLanguages in the
// app's own defaults domain (never the global one), as macOS's per-app language
// setting does: AppKit and Chromium's own strings pick it up at the next launch.
// System removes the entry, so the computer's own list applies again.
const APPLE_LANGUAGES = "AppleLanguages";

/**
 * What the app's own AppleLanguages entry should hold for a preference: the
 * chosen language alone, or null for no entry, so System follows the computer.
 */
export function appKitLanguages(preference: LanguagePreference): string[] | null {
  return preference === "system" ? null : [preference];
}

function alignAppKit(preference: LanguagePreference): void {
  if (process.platform !== "darwin") return;
  const languages = appKitLanguages(preference);
  try {
    if (languages === null) systemPreferences.removeUserDefault(APPLE_LANGUAGES);
    else systemPreferences.setUserDefault(APPLE_LANGUAGES, "array", languages);
  } catch (err) {
    warn("could not align macOS's own menu items with the interface language", {
      preference,
      error: serializeError(err),
    });
  }
}

/** The computer's preferred languages, not the app's own entry, which would
 *  shadow them; the entry is written back when the saved choice is applied. */
function computerLanguages(): string[] {
  if (process.platform === "darwin") systemPreferences.removeUserDefault(APPLE_LANGUAGES);
  return app.getPreferredSystemLanguages();
}

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
  computerLanguage = systemLanguage(computerLanguages());
  computerLocale = app.getSystemLocale() || null;
  settle("system");
}

/** Applies the saved choice at launch; nothing is drawn yet. */
export function applyLanguagePreference(preference: LanguagePreference): void {
  settle(preference);
  alignAppKit(preference);
}

/**
 * Applies a choice saved in Settings: every window is told, and `onChanged`
 * redraws what the main process draws (the application menu). Returns whether
 * the language changed. macOS's own menu items follow at the next launch,
 * even when the choice leaves this session's language as it is.
 */
export function changeLanguagePreference(preference: LanguagePreference, onChanged: () => void): boolean {
  alignAppKit(preference);
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
