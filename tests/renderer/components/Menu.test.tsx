import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Menu, MenuItem } from "@renderer/components/Menu";

afterEach(cleanup);

// Some existing cases wait a frame after opening; focus is already initialized
// before paint, so waiting cannot replace or undo subsequent navigation.
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

beforeEach(() => {
  // jsdom lacks layout; focus() works, but ensure no element method is missing.
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  }
});

describe("Menu independent pointer and keyboard targets", () => {
  it("initializes and navigates only eligible commands", () => {
    const { getByTestId, getByRole } = render(<Menu label="Actions" trigger={(props) => <button data-testid="trigger" {...props}>Open</button>}>
      <button role="menuitem" disabled>Unavailable first</button>
      <MenuItem onSelect={() => {}}>Apple</MenuItem>
      <MenuItem onSelect={() => {}}>Banana</MenuItem>
      <button role="menuitem" aria-disabled="true">Unavailable last</button>
    </Menu>);
    fireEvent.keyDown(getByTestId("trigger"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(getByRole("menuitem", { name: "Banana" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(getByRole("menuitem", { name: "Apple" }));
  });

  it("keeps the contained zoom widget's activation separate from menu commands", () => {
    const command = vi.fn();
    const zoom = vi.fn();
    const { getByTestId, getByRole } = render(<Menu label="Actions" trigger={(props) => <button data-testid="trigger" {...props}>Open</button>}>
      <MenuItem onSelect={command}>Apple</MenuItem>
      <button onClick={zoom}>Zoom in</button>
    </Menu>);
    fireEvent.click(getByTestId("trigger"), { detail: 1 });
    const widget = getByRole("button", { name: "Zoom in" });
    widget.focus();
    expect(fireEvent.keyDown(widget, { key: " " })).toBe(true);
    fireEvent.click(widget);
    expect(zoom).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
    expect(getByRole("menu")).toBeTruthy();
  });

  it("ignores an IME confirmation key instead of activating the current command", () => {
    const command = vi.fn();
    const { trigger } = renderMenu(command);
    fireEvent.click(trigger, { detail: 1 });
    fireEvent.keyDown(document.activeElement!, { key: "Enter", isComposing: true });
    expect(command).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("opens quietly by pointer with navigation ready, and hover leaves the keyboard target alone", () => {
    const onFirst = vi.fn();
    const onThird = vi.fn();
    const { trigger } = renderMenu(onFirst, { onThird });
    fireEvent.click(trigger, { detail: 1 });
    const popup = screen.getByRole("menu");
    const [first, second, third] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);
    expect(popup.classList.contains("keyboard-navigation")).toBe(false);
    fireEvent.mouseMove(third!);
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    expect(popup.classList.contains("keyboard-navigation")).toBe(true);
    fireEvent.mouseMove(third!);
    expect(document.activeElement).toBe(second);
    fireEvent.click(third!);
    expect(onThird).toHaveBeenCalledTimes(1);
    expect(onFirst).not.toHaveBeenCalled();
  });

  it.each(["Enter", " ", "ArrowDown"])("opens from %s with the first keyboard target visible", (key) => {
    const { trigger } = renderMenu();
    fireEvent.keyDown(trigger, { key });
    const popup = screen.getByRole("menu");
    const [first, second] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(first);
    expect(popup.classList.contains("keyboard-navigation")).toBe(true);
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
  });

  it("opens from ArrowUp at the last eligible command, then moves immediately", () => {
    const { trigger } = renderMenu();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const [, second, last] = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(second);
  });

  it("continues keyboard navigation from its target after an earlier command is hovered", () => {
    const onSecond = vi.fn();
    const { trigger } = renderMenu(vi.fn(), { onSecond });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const [first, second, third] = screen.getAllByRole("menuitem");
    fireEvent.keyDown(first!, { key: "ArrowDown" });
    fireEvent.keyDown(second!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(third);
    fireEvent.mouseMove(first!);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onSecond).toHaveBeenCalledTimes(1);
  });

  it.each(["Enter", " "])("%s activates the keyboard target after another command is hovered", (key) => {
    const onFirst = vi.fn();
    const onThird = vi.fn();
    const { trigger } = renderMenu(onFirst, { onThird });
    fireEvent.click(trigger, { detail: 1 });
    const [first, , third] = screen.getAllByRole("menuitem");
    fireEvent.mouseMove(third!);
    fireEvent.keyDown(first!, { key });
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onThird).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
