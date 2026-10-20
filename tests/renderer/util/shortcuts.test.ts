import { afterEach, describe, expect, it } from "vitest";
import {
  matchesShortcut,
  shadowsMacTextBinding,
  shortcutKeys,
  SHORTCUTS,
} from "../../../src/renderer/src/util/shortcuts";

// The command modifier and the macOS text-field rule decide by platform; each
// case supplies the platform, since jsdom reports none.
function onPlatform(platform: string): void {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  delete (navigator as { platform?: string }).platform;
});

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { key: "n", ...init });

describe("matchesShortcut", () => {
  it("takes Cmd or Ctrl as the command modifier", () => {
    expect(matchesShortcut(SHORTCUTS.newPost, { key: "n", metaKey: true })).toBe(true);
    expect(matchesShortcut(SHORTCUTS.newPost, { key: "n", ctrlKey: true })).toBe(true);
    expect(matchesShortcut(SHORTCUTS.newPost, { key: "n" })).toBe(false);
  });

  it("ignores Ctrl+Alt, which Chromium delivers for Windows AltGr", () => {
    expect(matchesShortcut(SHORTCUTS.newPost, { key: "n", ctrlKey: true, altKey: true })).toBe(false);
  });

  it("keeps Shift distinct on a letter chord and tolerates it on Slash", () => {
    expect(matchesShortcut(SHORTCUTS.newPost, { key: "N", metaKey: true, shiftKey: true })).toBe(false);
    expect(matchesShortcut(SHORTCUTS.showShortcuts, { key: "/", metaKey: true, shiftKey: true })).toBe(true);
    expect(matchesShortcut(SHORTCUTS.showShortcuts, { key: "?", metaKey: true, shiftKey: true })).toBe(true);
  });

  it("matches a list row action whatever modifiers are held", () => {
    expect(matchesShortcut(SHORTCUTS.removeWorkspace, { key: "Backspace", metaKey: true, altKey: true })).toBe(true);
    expect(matchesShortcut(SHORTCUTS.renameWorkspace, { key: "F2", shiftKey: true })).toBe(true);
    expect(matchesShortcut(SHORTCUTS.renameWorkspace, { key: "r" })).toBe(false);
  });
});

describe("shortcutKeys", () => {
  it("writes a shared modifier once and spaces independent chords", () => {
    expect(shortcutKeys(SHORTCUTS.settings, "Cmd")).toBe("Cmd+Comma");
    expect(shortcutKeys(SHORTCUTS.showShortcuts, "Ctrl")).toBe("Ctrl+Slash");
    expect(shortcutKeys(SHORTCUTS.renameWorkspace, "Cmd")).toBe("F2 / Cmd+R");
    expect(shortcutKeys(SHORTCUTS.removeWorkspace, "Cmd")).toBe("Delete/Backspace");
  });
});

describe("shadowsMacTextBinding", () => {
  it("leaves Ctrl to the text system on macOS", () => {
    onPlatform("MacIntel");
    expect(shadowsMacTextBinding(key({ ctrlKey: true }))).toBe(true);
    expect(shadowsMacTextBinding(key({ metaKey: true }))).toBe(false);
  });

  it("lets Ctrl through on Windows and Linux", () => {
    onPlatform("Win32");
    expect(shadowsMacTextBinding(key({ ctrlKey: true }))).toBe(false);
    onPlatform("Linux x86_64");
    expect(shadowsMacTextBinding(key({ ctrlKey: true }))).toBe(false);
  });
});
