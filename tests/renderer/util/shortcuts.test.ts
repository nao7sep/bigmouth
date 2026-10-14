import { afterEach, describe, expect, it } from "vitest";
import { hasMod, shadowsMacTextBinding } from "../../../src/renderer/src/util/shortcuts";

// The command modifier and the macOS text-field rule decide by platform; each
// case supplies the platform, since jsdom reports none.
function onPlatform(platform: string): void {
  Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  delete (navigator as { platform?: string }).platform;
});

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", { key: "n", ...init });

describe("hasMod", () => {
  it("takes Cmd or Ctrl as the command modifier", () => {
    expect(hasMod({ metaKey: true, ctrlKey: false, altKey: false })).toBe(true);
    expect(hasMod({ metaKey: false, ctrlKey: true, altKey: false })).toBe(true);
    expect(hasMod({ metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });

  it("ignores Ctrl+Alt, which Chromium delivers for Windows AltGr", () => {
    expect(hasMod({ metaKey: false, ctrlKey: true, altKey: true })).toBe(false);
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
