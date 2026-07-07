import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";

import { ShortcutsModal } from "@renderer/components/ShortcutsModal";

afterEach(cleanup);

describe("ShortcutsModal", () => {
  it("renders the dialog titled Keyboard Shortcuts", () => {
    const { getByRole } = render(<ShortcutsModal onClose={vi.fn()} />);
    const labelId = getByRole("dialog").getAttribute("aria-labelledby");
    expect(document.getElementById(labelId!)?.textContent).toBe("Keyboard Shortcuts");
  });

  it("lists every shortcut row with its key and description", () => {
    const { container, getByText } = render(<ShortcutsModal onClose={vi.fn()} />);
    // One <tr> per shortcut entry (10 of them).
    expect(container.querySelectorAll("tbody tr")).toHaveLength(10);
    // Spot-check a representative binding and its label.
    expect(getByText("New post")).toBeTruthy();
    const kbds = Array.from(container.querySelectorAll("kbd")).map((k) => k.textContent);
    // Mac-first default (no platform stubbed) shows the single "Cmd" word, with
    // punctuation spelled out per the keyboard-shortcut convention — never a glyph
    // or raw symbol, and never the combined "Cmd/Ctrl" form.
    expect(kbds).toContain("Cmd+N");
    expect(kbds).toContain("Cmd+Slash");
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
