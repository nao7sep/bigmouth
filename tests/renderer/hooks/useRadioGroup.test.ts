import { afterEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRadioGroup } from "@renderer/hooks/useRadioGroup";

afterEach(cleanup);

const VALUES = ["a", "b", "c"] as const;
type Value = (typeof VALUES)[number];

// A fake keydown: only `key` matters to the hook, and preventDefault is spied so
// we can assert the hook claimed the event.
function keyEvent(key: string) {
  const preventDefault = vi.fn();
  return { event: { key, preventDefault } as unknown as ReactKeyboardEvent, preventDefault };
}

function setup(value: Value = "a") {
  const onCommit = vi.fn<(v: Value) => void>();
  const { result, rerender } = renderHook(
    (props: { value: Value }) =>
      useRadioGroup<Value>({ values: VALUES, value: props.value, onCommit }),
    { initialProps: { value } },
  );
  return { result, rerender, onCommit };
}

describe("useRadioGroup", () => {
  it("exposes the radiogroup role and per-value radio props", () => {
    const { result } = setup("b");
    expect(result.current.radioGroupProps).toEqual({ role: "radiogroup" });

    const props = result.current.getRadioProps("b");
    expect(props.role).toBe("radio");
    expect(props["aria-checked"]).toBe(true);
    // The committed value is the resting tab stop.
    expect(props.tabIndex).toBe(0);
    expect(result.current.getRadioProps("a")["aria-checked"]).toBe(false);
    expect(result.current.getRadioProps("a").tabIndex).toBe(-1);
  });

  it("commits on click only when the value changes", () => {
    const { result, onCommit } = setup("a");
    act(() => result.current.getRadioProps("b").onClick());
    expect(onCommit).toHaveBeenCalledWith("b");

    onCommit.mockClear();
    // Clicking the already-committed value moves the cursor but does not re-commit.
    act(() => result.current.getRadioProps("a").onClick());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ArrowRight/ArrowDown move the cursor without committing", () => {
    const { result, onCommit } = setup("a");
    const right = keyEvent("ArrowRight");
    act(() => result.current.getRadioProps("a").onKeyDown(right.event));
    expect(right.preventDefault).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    // Cursor moved to "b": it is now the tab stop, but "a" is still checked.
    expect(result.current.getRadioProps("b").tabIndex).toBe(0);
    expect(result.current.getRadioProps("a").tabIndex).toBe(-1);
    expect(result.current.getRadioProps("a")["aria-checked"]).toBe(true);

    const down = keyEvent("ArrowDown");
    act(() => result.current.getRadioProps("b").onKeyDown(down.event));
    expect(result.current.getRadioProps("c").tabIndex).toBe(0);
  });

  it("ArrowLeft/ArrowUp move the cursor backward, clamped at the start", () => {
    const { result } = setup("b");
    const left = keyEvent("ArrowLeft");
    act(() => result.current.getRadioProps("b").onKeyDown(left.event));
    expect(result.current.getRadioProps("a").tabIndex).toBe(0);

    // Already at the first value: stop-at-ends, no wrap.
    const up = keyEvent("ArrowUp");
    act(() => result.current.getRadioProps("a").onKeyDown(up.event));
    expect(result.current.getRadioProps("a").tabIndex).toBe(0);
  });

  it("Home and End jump the cursor to the ends", () => {
    const { result } = setup("b");
    act(() => result.current.getRadioProps("b").onKeyDown(keyEvent("End").event));
    expect(result.current.getRadioProps("c").tabIndex).toBe(0);

    act(() => result.current.getRadioProps("c").onKeyDown(keyEvent("Home").event));
    expect(result.current.getRadioProps("a").tabIndex).toBe(0);
  });

  it("Enter/Space commit the cursor's value (manual activation)", () => {
    const { result, rerender, onCommit } = setup("a");
    // Move the cursor to "c" first, then commit with Enter.
    act(() => result.current.getRadioProps("a").onKeyDown(keyEvent("End").event));
    const enter = keyEvent("Enter");
    act(() => result.current.getRadioProps("c").onKeyDown(enter.event));
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith("c");

    // The parent commits the value, so the controlled `value` becomes "c". With
    // the cursor already on "c", Space is now a no-op (cursor === committed).
    rerender({ value: "c" });
    onCommit.mockClear();
    const space = keyEvent(" ");
    act(() => result.current.getRadioProps("c").onKeyDown(space.event));
    expect(space.preventDefault).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores unrelated keys", () => {
    const { result, onCommit } = setup("a");
    const tab = keyEvent("Tab");
    act(() => result.current.getRadioProps("a").onKeyDown(tab.event));
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rests the cursor on the committed value when no explicit cursor is set", () => {
    const { result, rerender } = setup("a");
    // Committed value changes externally; the resting tab stop follows it.
    rerender({ value: "c" });
    expect(result.current.getRadioProps("c").tabIndex).toBe(0);
    expect(result.current.getRadioProps("a").tabIndex).toBe(-1);
  });
});
