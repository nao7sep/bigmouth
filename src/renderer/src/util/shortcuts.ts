import type { MessageKey } from "@shared/i18n/catalogues";

/**
 * The app's keyboard shortcuts, in one table: every handler matches its chords
 * through {@link matchesShortcut}, and the Shortcuts dialog renders the same
 * entries with {@link shortcutKeys}, so the dialog cannot drift from what the
 * keys do (keyboard-shortcut-conventions). The context rules — IME composition,
 * the macOS Ctrl stand-down in text fields, an open modal — stay with each
 * handler, since they decide whether a matched chord may act, not which chord
 * it is.
 */

/** Whether a modifier must be held, must not be, or does not matter. */
type Hold = "yes" | "no" | "any";

interface Chord {
  /** `KeyboardEvent.key`; a letter matches in either case. */
  key: string;
  /**
   * The same keycap's `key` when the layout delivers it shifted (US Shift+/ is
   * "?"); matched like `key`, never shown, since it is the same chord.
   */
  shiftedKey?: string;
  /** The command modifier: Cmd or Ctrl, either accepted on every platform. Default "no". */
  mod?: Hold;
  /** Default "no". */
  shift?: Hold;
  /**
   * Default "no": Chromium delivers Windows AltGr as Ctrl+Alt, so a command
   * chord never accepts Alt. Only a non-printing key (F2, Delete) may take
   * "any", since AltGr types no character with it.
   */
  alt?: Hold;
}

export interface Shortcut {
  description: MessageKey;
  /** Alternatives, shown " / "-separated; the keys within one are equivalent and shown "/"-joined. */
  chords: readonly (readonly Chord[])[];
}

const command = (key: string, shift: Hold = "any"): Chord => ({ key, mod: "yes", shift });
// A row action in a list fires whatever modifiers are held.
const anyHeld = (key: string): Chord => ({ key, mod: "any", shift: "any", alt: "any" });

export const SHORTCUTS = {
  // Enter already opens the active row, so it cannot double as rename (Finder's
  // key); Cmd+R is the command-modifier fallback, and a bare "r" stays type-ahead.
  renameWorkspace: { description: "shortcuts.renameWorkspace", chords: [[anyHeld("F2")], [command("r", "no")]] },
  // Backspace is the key a Mac keyboard labels delete.
  removeWorkspace: { description: "workspaces.removeTitle", chords: [[anyHeld("Delete"), anyHeld("Backspace")]] },
  newPost: { description: "shortcuts.newPost", chords: [[command("n", "no")]] },
  settings: { description: "settings.title", chords: [[command(",")]] },
  // Shift is tolerated so shifted-slash layouts (German QWERTZ) reach the chord.
  showShortcuts: { description: "shortcuts.title", chords: [[{ ...command("/"), shiftedKey: "?" }]] },
  runAnalysis: { description: "shortcuts.runAnalysis", chords: [[command("Enter")]] },
  exportPost: { description: "shortcuts.export", chords: [[command("e", "no")]] },
  // Digits tolerate Shift: some layouts (French AZERTY) type them shifted.
  tabAnalysis: { description: "tabs.analysis", chords: [[command("1")]] },
  tabImaging: { description: "tabs.imaging", chords: [[command("2")]] },
  tabAssets: { description: "tabs.assets", chords: [[command("3")]] },
  tabPreview: { description: "tabs.preview", chords: [[command("4")]] },
  tabMetadata: { description: "tabs.metadata", chords: [[command("5")]] },
} as const satisfies Record<string, Shortcut>;

/**
 * The Shortcuts dialog's groups, broadest first and in the app menu's order:
 * the workspace list, the app's own dialogs, the open post, then its tabs. A
 * group whose chords act only in some context carries a note saying so, since
 * advertising an unreachable chord is as wrong as listing one that is unbound.
 */
export const SHORTCUT_GROUPS: readonly {
  title: MessageKey;
  note: MessageKey | null;
  shortcuts: readonly Shortcut[];
}[] = [
  {
    title: "shortcuts.groupWorkspaces",
    note: "shortcuts.noteWorkspaces",
    shortcuts: [SHORTCUTS.renameWorkspace, SHORTCUTS.removeWorkspace],
  },
  {
    title: "shortcuts.groupApp",
    note: null,
    shortcuts: [SHORTCUTS.newPost, SHORTCUTS.settings, SHORTCUTS.showShortcuts],
  },
  {
    title: "shortcuts.groupPost",
    note: "shortcuts.notePost",
    shortcuts: [SHORTCUTS.runAnalysis, SHORTCUTS.exportPost],
  },
  {
    title: "shortcuts.groupTabs",
    note: "shortcuts.noteTabs",
    shortcuts: [
      SHORTCUTS.tabAnalysis,
      SHORTCUTS.tabImaging,
      SHORTCUTS.tabAssets,
      SHORTCUTS.tabPreview,
      SHORTCUTS.tabMetadata,
    ],
  },
];

/** Typed structurally so a native event and a React one both fit. */
type KeyInput = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

function holds(rule: Hold | undefined, held: boolean): boolean {
  const wanted = rule ?? "no";
  return wanted === "any" || (wanted === "yes") === held;
}

function keyMatches(wanted: string, actual: string): boolean {
  return wanted.length === 1 ? actual.toLowerCase() === wanted.toLowerCase() : actual === wanted;
}

function chordMatches(chord: Chord, e: KeyInput): boolean {
  const key = keyMatches(chord.key, e.key) || (chord.shiftedKey !== undefined && keyMatches(chord.shiftedKey, e.key));
  return (
    key &&
    holds(chord.mod, Boolean(e.metaKey || e.ctrlKey)) &&
    holds(chord.shift, Boolean(e.shiftKey)) &&
    holds(chord.alt, Boolean(e.altKey))
  );
}

/** Whether the event is one of the shortcut's chords. */
export function matchesShortcut(shortcut: Shortcut, e: KeyInput): boolean {
  return shortcut.chords.some((alternative) => alternative.some((chord) => chordMatches(chord, e)));
}

// Full key names; punctuation spelled as a word (keyboard-shortcut-conventions).
const KEY_NAMES: Record<string, string> = { ",": "Comma", "/": "Slash" };

function keyName(key: string): string {
  return KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

function prefix(chord: Chord, mod: string): string {
  return `${chord.mod === "yes" ? `${mod}+` : ""}${chord.shift === "yes" ? "Shift+" : ""}`;
}

/**
 * The keys as the Shortcuts dialog shows them; `mod` is "Cmd" or "Ctrl". A
 * modifier every chord shares is written once; otherwise each alternative is
 * written in full and spaced: "F2 / Cmd+R". Key names stay English in every
 * language, since they name the keycaps.
 */
export function shortcutKeys(shortcut: Shortcut, mod: string): string {
  const all = shortcut.chords.flat();
  const first = prefix(all[0]!, mod);
  const shared = all.every((chord) => prefix(chord, mod) === first) ? first : null;
  const alternatives = shortcut.chords.map((alternative) =>
    alternative.map((chord) => `${shared === null ? prefix(chord, mod) : ""}${keyName(chord.key)}`).join("/"),
  );
  return `${shared ?? ""}${alternatives.join(" / ")}`;
}

// navigator.platform is deprecated but still reliable in Electron's renderer.
// Read at each call rather than once at import, so tests can supply either
// platform.
function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(
    typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
  );
}

/**
 * On macOS, Ctrl inside a text field belongs to the text system whatever the
 * key is, so the Ctrl half of a dual-bound chord stands down there — one
 * blanket test, no per-chord key list (keyboard-shortcut-conventions). The
 * Cmd half is the binding and always fires.
 */
export function shadowsMacTextBinding(e: KeyboardEvent): boolean {
  return isApplePlatform() && e.ctrlKey && !e.metaKey;
}

/**
 * One editable-target predicate for the whole app. The parentElement walk is
 * load-bearing: the CodeMirror editor's event target is a DIV descendant of
 * its contenteditable, so a tagName-only test sees a plain DIV and lets every
 * chord through.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  let current = target instanceof HTMLElement ? target : null;
  while (current) {
    if (current.isContentEditable) return true;
    if (current.tagName === "TEXTAREA") return true;
    if (current.tagName === "INPUT") {
      const type = (current.getAttribute("type") ?? "text").toLowerCase();
      return !["checkbox", "radio", "range", "button", "submit", "reset", "color", "file"].includes(type);
    }
    current = current.parentElement;
  }
  return false;
}
