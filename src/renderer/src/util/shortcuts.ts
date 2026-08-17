// navigator.platform is deprecated but still reliable in Electron's renderer.
const isApplePlatform = /Mac|iPhone|iPad|iPod/.test(
  typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent,
);

/** Alt is excluded because Chromium delivers Windows AltGr as Ctrl+Alt. */
export function hasMod(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey;
}

/**
 * On macOS, Ctrl inside a text field belongs to the text system whatever the
 * key is, so the Ctrl half of a dual-bound chord stands down there — one
 * blanket test, no per-chord key list (keyboard-shortcut-conventions). The
 * Cmd half is the binding and always fires.
 */
export function shadowsMacTextBinding(e: KeyboardEvent): boolean {
  return isApplePlatform && e.ctrlKey && !e.metaKey;
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
