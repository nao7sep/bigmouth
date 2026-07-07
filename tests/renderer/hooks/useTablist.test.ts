import { afterEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTablist } from "@renderer/hooks/useTablist";

afterEach(cleanup);

const TABS = ["one", "two", "three"] as const;
type Tab = (typeof TABS)[number];

function keyEvent(key: string) {
  const preventDefault = vi.fn();
  return { event: { key, preventDefault } as unknown as ReactKeyboardEvent, preventDefault };
}

function setup(selected: Tab = "one") {
  const onSelect = vi.fn<(t: Tab) => void>();
  const { result, rerender } = renderHook(
    (props: { selected: Tab }) =>
      useTablist<Tab>({ tabs: TABS, selected: props.selected, onSelect, idBase: "tl" }),
    { initialProps: { selected } },
  );
  return { result, rerender, onSelect };
}

describe("useTablist", () => {
  it("exposes tablist/tab/panel props with a roving tabindex on the selected tab", () => {
    const { result } = setup("two");
    expect(result.current.tablistProps).toEqual({ role: "tablist" });

    const tabTwo = result.current.getTabProps("two");
    expect(tabTwo.role).toBe("tab");
    expect(tabTwo["aria-selected"]).toBe(true);
    expect(tabTwo.tabIndex).toBe(0);
    expect(tabTwo.id).toBe("tl-tab-two");
    expect(tabTwo["aria-controls"]).toBe("tl-panel-two");

    const tabOne = result.current.getTabProps("one");
    expect(tabOne["aria-selected"]).toBe(false);
    expect(tabOne.tabIndex).toBe(-1);

    const panel = result.current.getPanelProps("two");
    expect(panel).toEqual({
      role: "tabpanel",
      id: "tl-panel-two",
      "aria-labelledby": "tl-tab-two",
    });
  });

  it("selects on click", () => {
    const { result, onSelect } = setup("one");
    act(() => result.current.getTabProps("three").onClick());
    expect(onSelect).toHaveBeenCalledWith("three");
  });

  it("ArrowRight/ArrowDown select the next tab (activation follows focus)", () => {
    const { result, onSelect } = setup("one");
    const right = keyEvent("ArrowRight");
    act(() => result.current.getTabProps("one").onKeyDown(right.event));
    expect(right.preventDefault).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("two");

    onSelect.mockClear();
    const down = keyEvent("ArrowDown");
    act(() => result.current.getTabProps("one").onKeyDown(down.event));
    expect(onSelect).toHaveBeenCalledWith("two");
  });

  it("ArrowLeft/ArrowUp select the previous tab", () => {
    const { result, onSelect } = setup("two");
    act(() => result.current.getTabProps("two").onKeyDown(keyEvent("ArrowLeft").event));
    expect(onSelect).toHaveBeenCalledWith("one");

    onSelect.mockClear();
    act(() => result.current.getTabProps("two").onKeyDown(keyEvent("ArrowUp").event));
    expect(onSelect).toHaveBeenCalledWith("one");
  });

  it("stops at the ends — no wrap and no spurious select", () => {
    const atEnd = setup("three");
    const right = keyEvent("ArrowRight");
    act(() => atEnd.result.current.getTabProps("three").onKeyDown(right.event));
    expect(right.preventDefault).toHaveBeenCalled();
    // Target resolves back to "three" (clamped) === selected, so no onSelect.
    expect(atEnd.onSelect).not.toHaveBeenCalled();

    const atStart = setup("one");
    act(() => atStart.result.current.getTabProps("one").onKeyDown(keyEvent("ArrowLeft").event));
    expect(atStart.onSelect).not.toHaveBeenCalled();
  });

  it("Home/End jump to the first/last tab", () => {
    const { result, onSelect } = setup("two");
    act(() => result.current.getTabProps("two").onKeyDown(keyEvent("End").event));
    expect(onSelect).toHaveBeenCalledWith("three");

    onSelect.mockClear();
    act(() => result.current.getTabProps("two").onKeyDown(keyEvent("Home").event));
    expect(onSelect).toHaveBeenCalledWith("one");
  });

  it("Home from the first tab does not re-select it", () => {
    const { result, onSelect } = setup("one");
    act(() => result.current.getTabProps("one").onKeyDown(keyEvent("Home").event));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("ignores unrelated keys without preventing default", () => {
    const { result, onSelect } = setup("one");
    const space = keyEvent(" ");
    act(() => result.current.getTabProps("one").onKeyDown(space.event));
    expect(space.preventDefault).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("namespaces ids by idBase so multiple tablists never collide", () => {
    const { result } = renderHook(() =>
      useTablist<Tab>({ tabs: TABS, selected: "one", onSelect: () => {}, idBase: "other" }),
    );
    expect(result.current.getTabProps("one").id).toBe("other-tab-one");
    expect(result.current.getPanelProps("one").id).toBe("other-panel-one");
  });
});
