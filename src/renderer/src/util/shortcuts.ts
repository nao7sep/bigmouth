// The leaf home of the command-modifier predicate and the macOS text-editing
// guards (keyboard-shortcut-conventions). Every accelerator site imports from
// here; a per-file copy is what lets two chords disagree.

// navigator.platform is deprecated but still reliable in Electron's renderer.
const isApplePlatform = /Mac|iPhone|iPad|iPod/.test(
  typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
);

/**
 * The one shared command-modifier predicate: BOTH Cmd and Ctrl fire on every
 * platform, and Alt is excluded because Chromium delivers Windows AltGr as
 * Ctrl+Alt — an unguarded predicate would let an AltGr-typed character
 * (unmapped combos fall back to the base key) fire an accelerator and
 * swallow the character.
 */
export function hasMod(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey;
}

// Bare-Ctrl chords on these keys shadow Cocoa's text-editing keymap
// (StandardKeyBinding.dict — Ctrl+E is move-to-end-of-paragraph, Ctrl+N
// next-line, and Ctrl+Slash is bound too).
const COCOA_CTRL_TEXT_KEYS = new Set([
  "a", "b", "d", "e", "f", "h", "k", "l", "n", "o", "p", "t", "v", "y", "/",
]);

/**
 * True when this chord shadows a macOS text-editing binding and must stand
 * down while the event target is editable; the Cmd half of the same chord is
 * unbound there and always fires (keyboard-shortcut-conventions).
 */
export function shadowsMacTextBinding(e: KeyboardEvent): boolean {
  if (!isApplePlatform) return false;
  if (e.metaKey || !e.ctrlKey) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return COCOA_CTRL_TEXT_KEYS.has(key);
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
