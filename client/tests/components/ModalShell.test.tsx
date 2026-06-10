import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ModalShell } from "../../src/components/ModalShell";

afterEach(cleanup);

// `fireEvent` returns false when the dispatched event had preventDefault called,
// which is how the focus trap signals it handled (and swallowed) a Tab.
const TAB = { key: "Tab" } as const;

function renderShell() {
  return render(
    <ModalShell title="Dialog" onClose={() => {}} showClose={false}>
      <button data-testid="a">A</button>
      <button data-testid="b">B</button>
      <button data-testid="c">C</button>
    </ModalShell>
  );
}

describe("ModalShell accessibility", () => {
  it("exposes dialog semantics with the title as the accessible name", () => {
    const { getByRole } = render(
      <ModalShell title="My Dialog" onClose={() => {}}>
        body
      </ModalShell>
    );
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toBe("My Dialog");
  });

  it("moves focus into the dialog on open", () => {
    const { getByTestId } = renderShell();
    expect(document.activeElement).toBe(getByTestId("a"));
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <ModalShell title="X" onClose={onClose}>
        body
      </ModalShell>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus from an autoFocus child", () => {
    const { getByTestId } = render(
      <ModalShell title="X" onClose={() => {}} showClose={false}>
        <button data-testid="first">First</button>
        <button data-testid="chosen" autoFocus>
          Chosen
        </button>
      </ModalShell>
    );
    expect(document.activeElement).toBe(getByTestId("chosen"));
  });
});

describe("ModalShell focus trap", () => {
  it("wraps Tab from the last focusable back to the first", () => {
    const { getByTestId } = renderShell();
    getByTestId("c").focus();
    expect(fireEvent.keyDown(getByTestId("c"), TAB)).toBe(false);
    expect(document.activeElement).toBe(getByTestId("a"));
  });

  it("wraps Shift+Tab from the first focusable back to the last", () => {
    const { getByTestId } = renderShell();
    getByTestId("a").focus();
    expect(fireEvent.keyDown(getByTestId("a"), { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(getByTestId("c"));
  });

  it("leaves Tab alone away from the edges", () => {
    const { getByTestId } = renderShell();
    getByTestId("a").focus();
    // Not on the last element, so the trap does not intervene.
    expect(fireEvent.keyDown(getByTestId("a"), TAB)).toBe(true);
    expect(document.activeElement).toBe(getByTestId("a"));
  });
});

describe("ModalShell focus restore", () => {
  function RestoreHarness({ open }: { open: boolean }) {
    return (
      <>
        <button data-testid="trigger">Trigger</button>
        {open && (
          <ModalShell title="X" onClose={() => {}} showClose={false}>
            <button data-testid="inside">In</button>
          </ModalShell>
        )}
      </>
    );
  }

  it("returns focus to the trigger when the dialog closes", () => {
    const { getByTestId, rerender } = render(<RestoreHarness open={false} />);
    const trigger = getByTestId("trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    rerender(<RestoreHarness open />);
    expect(document.activeElement).toBe(getByTestId("inside"));

    rerender(<RestoreHarness open={false} />);
    expect(document.activeElement).toBe(trigger);
  });
});

describe("ModalShell unmount", () => {
  function Harness({ show }: { show: boolean }) {
    return show ? (
      <ModalShell title="X" onClose={() => {}}>
        body
      </ModalShell>
    ) : null;
  }

  it("stops handling Escape once unmounted", () => {
    const { rerender } = render(<Harness show />);
    rerender(<Harness show={false} />);
    // The layer is gone, so the stack's document listener was detached; Escape
    // must not throw or reach a stale handler.
    expect(() => fireEvent.keyDown(document, { key: "Escape" })).not.toThrow();
  });
});
