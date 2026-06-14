import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useEffect, useState } from "react";
import { ModalShell } from "../../src/components/ModalShell";
import { useAnyModalOpen } from "../../src/hooks/useModalStack";

afterEach(cleanup);

describe("modal stack — topmost-only Escape", () => {
  function StackHarness({
    showSecond,
    onCloseFirst,
    onCloseSecond,
  }: {
    showSecond: boolean;
    onCloseFirst: () => void;
    onCloseSecond: () => void;
  }) {
    // Mount order is stack order: the second shell mounts last, so it is the
    // topmost layer.
    return (
      <>
        <ModalShell title="First" onClose={onCloseFirst}>
          first
        </ModalShell>
        {showSecond && (
          <ModalShell title="Second" onClose={onCloseSecond}>
            second
          </ModalShell>
        )}
      </>
    );
  }

  it("closes only the topmost layer and unwinds one at a time", () => {
    const onCloseFirst = vi.fn();
    const onCloseSecond = vi.fn();
    const { rerender } = render(
      <StackHarness showSecond onCloseFirst={onCloseFirst} onCloseSecond={onCloseSecond} />
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCloseSecond).toHaveBeenCalledTimes(1);
    expect(onCloseFirst).not.toHaveBeenCalled();

    // The top layer closes (unmounts); the next Escape reaches the layer beneath.
    rerender(
      <StackHarness
        showSecond={false}
        onCloseFirst={onCloseFirst}
        onCloseSecond={onCloseSecond}
      />
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCloseFirst).toHaveBeenCalledTimes(1);
    expect(onCloseSecond).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while an IME composition is in progress", () => {
    const onCloseFirst = vi.fn();
    const onCloseSecond = vi.fn();
    render(
      <StackHarness showSecond onCloseFirst={onCloseFirst} onCloseSecond={onCloseSecond} />
    );

    // Escape during composition cancels the IME candidate, not the modal.
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    expect(onCloseSecond).not.toHaveBeenCalled();
    expect(onCloseFirst).not.toHaveBeenCalled();

    // Once composition has ended, Escape closes the topmost layer again.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCloseSecond).toHaveBeenCalledTimes(1);
    expect(onCloseFirst).not.toHaveBeenCalled();
  });
});

describe("modal stack — shortcut suppression", () => {
  // Mirrors how WorkspaceSession gates its global keyboard shortcuts: the
  // handler is only attached while no modal is open.
  function ShortcutHarness({ open }: { open: boolean }) {
    const anyModalOpen = useAnyModalOpen();
    const [hits, setHits] = useState(0);

    useEffect(() => {
      if (anyModalOpen) return;
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "n") setHits((n) => n + 1);
      };
      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, [anyModalOpen]);

    return (
      <>
        <span data-testid="hits">{hits}</span>
        {open && (
          <ModalShell title="Modal" onClose={() => {}}>
            body
          </ModalShell>
        )}
      </>
    );
  }

  it("fires shortcuts only while no modal is open", () => {
    const press = () => fireEvent.keyDown(document.body, { key: "n", metaKey: true });
    const { getByTestId, rerender } = render(<ShortcutHarness open={false} />);

    press();
    expect(getByTestId("hits").textContent).toBe("1");

    // With a modal open, the global shortcut is suppressed.
    rerender(<ShortcutHarness open />);
    press();
    expect(getByTestId("hits").textContent).toBe("1");

    // Closing the modal re-enables it.
    rerender(<ShortcutHarness open={false} />);
    press();
    expect(getByTestId("hits").textContent).toBe("2");
  });
});
