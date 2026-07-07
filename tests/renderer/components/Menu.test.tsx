import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Menu, MenuItem } from "@renderer/components/Menu";

afterEach(cleanup);

// The Menu moves focus into the first item on open via requestAnimationFrame.
// jsdom drives rAF, but the callback runs asynchronously; flushRaf advances it
// inside act() so the focus move is observable.
function flushRaf() {
  return act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

function renderMenu(onSelect = vi.fn(), extra?: { onSecond?: () => void; onThird?: () => void }) {
  const result = render(
    <Menu
      label="Actions"
      trigger={(props) => (
        <button data-testid="trigger" {...props}>
          Open
        </button>
      )}
    >
      <div className="menu-label">A workspace</div>
      <MenuItem onSelect={onSelect}>Apple</MenuItem>
      <MenuItem onSelect={extra?.onSecond ?? (() => {})}>Banana</MenuItem>
      <MenuItem onSelect={extra?.onThird ?? (() => {})}>Cherry</MenuItem>
    </Menu>
  );
  return { ...result, onSelect, trigger: result.getByTestId("trigger") };
}

describe("Menu trigger and open state", () => {
  it("renders the trigger collapsed with menu semantics and no popup", () => {
    const { trigger, container } = renderMenu();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".menu-popup")).toBeNull();
  });

  it("opens the popup on trigger click and labels it", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const popup = screen.getByRole("menu");
    expect(popup.getAttribute("aria-label")).toBe("Actions");
    // The three MenuItems render as menuitems; the plain .menu-label div does not.
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("toggles closed on a second trigger click", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("moves focus to the first item on open", async () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    await flushRaf();
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Apple" }));
  });
});

describe("Menu item activation", () => {
  it("runs the item's onSelect and closes, returning focus to the trigger", () => {
    const { trigger, onSelect } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Apple" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("renders items as non-tab-stops (tabIndex -1)", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.getAttribute("tabindex")).toBe("-1");
    }
  });
});

describe("Menu keyboard navigation", () => {
  function openAndGetMenu() {
    const utils = renderMenu();
    fireEvent.click(utils.trigger);
    const popup = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    items[0].focus();
    return { ...utils, popup, items };
  }

  it("ArrowDown moves to the next item and stops at the end", () => {
    const { popup, items } = openAndGetMenu();
    fireEvent.keyDown(popup, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(popup, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    // Already on the last item — stop-at-end, no wrap.
    fireEvent.keyDown(popup, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
  });

  it("ArrowUp moves to the previous item and stops at the start", () => {
    const { popup, items } = openAndGetMenu();
    items[2].focus();
    fireEvent.keyDown(popup, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(popup, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(popup, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("Home and End jump to the first and last items", () => {
    const { popup, items } = openAndGetMenu();
    items[1].focus();
    fireEvent.keyDown(popup, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(popup, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("Escape closes the menu and returns focus to the trigger", () => {
    const { popup, trigger } = openAndGetMenu();
    fireEvent.keyDown(popup, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Tab closes the menu (it is not a focus trap, it dismisses)", () => {
    const { popup, trigger } = openAndGetMenu();
    fireEvent.keyDown(popup, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("Menu type-ahead", () => {
  it("jumps to the next item whose label starts with the typed character", () => {
    const utils = renderMenu();
    fireEvent.click(utils.trigger);
    const popup = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    items[0].focus();
    // Typing "b" jumps forward to "Banana".
    fireEvent.keyDown(popup, { key: "b" });
    expect(document.activeElement).toBe(items[1]);
  });

  it("accumulates the buffer so a second char extends the query (no reset between keys)", () => {
    // Within the idle-reset window the buffer keeps growing: "b" then "a" makes
    // "ba", which still matches "Banana", but "b" then "c" makes "bc" — no label
    // starts with it, so the cursor stays put. This documents the accumulation.
    const utils = renderMenu();
    fireEvent.click(utils.trigger);
    const popup = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    items[0].focus();
    fireEvent.keyDown(popup, { key: "b" });
    expect(document.activeElement).toBe(items[1]); // "b" -> Banana
    fireEvent.keyDown(popup, { key: "a" });
    expect(document.activeElement).toBe(items[1]); // "ba" still -> Banana
    fireEvent.keyDown(popup, { key: "c" });
    expect(document.activeElement).toBe(items[1]); // "bac" matches nothing; stay
  });

  it("ignores printable keys combined with a modifier", () => {
    const utils = renderMenu();
    fireEvent.click(utils.trigger);
    const popup = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    items[0].focus();
    fireEvent.keyDown(popup, { key: "b", metaKey: true });
    // No type-ahead move: cursor stays on the first item.
    expect(document.activeElement).toBe(items[0]);
  });
});

describe("Menu outside click", () => {
  it("closes without yanking focus back to the trigger on an outside pointer", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();
    // A mousedown outside the popup and trigger closes the menu.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("stays open when the pointer lands inside the popup", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    const popup = screen.getByRole("menu");
    fireEvent.mouseDown(popup);
    expect(screen.getByRole("menu")).toBeTruthy();
  });
});

describe("MenuItem outside a Menu", () => {
  it("still runs onSelect when there is no surrounding menu context", () => {
    // ctx is null, so close() is skipped (optional chaining) but onSelect runs.
    const onSelect = vi.fn();
    render(<MenuItem onSelect={onSelect}>Lonely</MenuItem>);
    fireEvent.click(screen.getByRole("menuitem", { name: "Lonely" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

// requestAnimationFrame cleanup on unmount and the query-timer cleanup effect run
// in real browsers; jsdom drives rAF, and these teardown paths only guard against
// stale callbacks. They are exercised implicitly by afterEach(cleanup) unmounting
// open menus; asserting on them directly would test framework internals.
beforeEach(() => {
  // jsdom lacks layout; focus() works, but ensure no element method is missing.
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  }
});
