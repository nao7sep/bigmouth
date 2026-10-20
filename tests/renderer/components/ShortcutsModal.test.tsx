import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

import { ShortcutsModal } from "@renderer/components/ShortcutsModal";
import { SHORTCUT_GROUPS, shortcutKeys } from "@renderer/util/shortcuts";
import { ENGLISH, type MessageKey } from "@shared/i18n/catalogues";

afterEach(cleanup);

describe("ShortcutsModal", () => {
  it("renders the dialog titled Keyboard Shortcuts", () => {
    const { getByRole } = render(<ShortcutsModal onClose={vi.fn()} />);
    const labelId = getByRole("dialog").getAttribute("aria-labelledby");
    expect(document.getElementById(labelId!)?.textContent).toBe("Keyboard Shortcuts");
  });

  it("lists exactly the shortcut table's rows, in its groups and order", () => {
    const { container } = render(<ShortcutsModal onClose={vi.fn()} />);
    const shown = Array.from(container.querySelectorAll(".shortcuts-group")).map((section) => ({
      title: section.querySelector(".shortcuts-group-title")?.textContent,
      note: section.querySelector(".shortcuts-group-note")?.textContent ?? null,
      rows: Array.from(section.querySelectorAll("tbody tr")).map((row) => [
        row.querySelector(".shortcut-desc")?.textContent,
        row.querySelector("kbd")?.textContent,
      ]),
    }));
    const text = (key: MessageKey) => ENGLISH[key] as string;
    expect(shown).toEqual(
      SHORTCUT_GROUPS.map((group) => ({
        title: text(group.title),
        note: group.note && text(group.note),
        rows: group.shortcuts.map((shortcut) => [text(shortcut.description), shortcutKeys(shortcut, "Cmd")]),
      })),
    );
  });

  it("shows each chord in the display convention's words", () => {
    const { container } = render(<ShortcutsModal onClose={vi.fn()} />);
    expect(Array.from(container.querySelectorAll(".shortcuts-group-title")).map((h) => h.textContent)).toEqual([
      "Workspaces",
      "App",
      "Post",
      "Tabs",
    ]);
    // Mac-first default (no platform stubbed): the single "Cmd" word, punctuation
    // spelled out, never a glyph, a raw symbol or the combined "Cmd/Ctrl" form.
    expect(Array.from(container.querySelectorAll("kbd")).map((k) => k.textContent)).toEqual([
      "F2 / Cmd+R",
      "Delete/Backspace",
      "Cmd+N",
      "Cmd+Comma",
      "Cmd+Slash",
      "Cmd+Enter",
      "Cmd+E",
      "Cmd+1",
      "Cmd+2",
      "Cmd+3",
      "Cmd+4",
      "Cmd+5",
    ]);
  });

  it("names Ctrl off macOS", () => {
    const saved = window.bigmouth;
    Object.defineProperty(window, "bigmouth", { value: { ...saved, platform: "win32" }, configurable: true, writable: true });
    try {
      const { container } = render(<ShortcutsModal onClose={vi.fn()} />);
      const kbds = Array.from(container.querySelectorAll("kbd")).map((k) => k.textContent);
      expect(kbds).toContain("Ctrl+N");
      expect(kbds).toContain("F2 / Ctrl+R");
      expect(kbds.some((k) => k?.includes("Cmd"))).toBe(false);
    } finally {
      Object.defineProperty(window, "bigmouth", { value: saved, configurable: true, writable: true });
    }
  });

  it("autofocuses the close button", () => {
    const { getByLabelText } = render(<ShortcutsModal onClose={vi.fn()} />);
    expect(document.activeElement).toBe(getByLabelText("Close"));
  });

  it("closes via the close button and via Escape", () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(<ShortcutsModal onClose={onClose} />);
    fireEvent.click(getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
