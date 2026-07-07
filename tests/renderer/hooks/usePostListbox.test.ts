import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { usePostListbox, type PostListRow } from "@renderer/hooks/usePostListbox";

afterEach(cleanup);

// jsdom has no layout, so scrollIntoView is undefined on elements the hook
// reaches for. The hook only calls it through registered refs; in renderHook we
// never register row elements, so scrollIntoView is never invoked. Still, guard
// it globally so any future ref registration would not throw.
beforeEach(() => {
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  }
});

const composingRef: RefObject<boolean> = { current: false };

function keyEvent(props: Record<string, unknown>) {
  const preventDefault = vi.fn();
  return {
    event: { preventDefault, ...props } as unknown as ReactKeyboardEvent,
    preventDefault,
  };
}

function rows(...labels: [string, string][]): PostListRow[] {
  return labels.map(([id, label]) => ({ id, label }));
}

function setup(opts: {
  rows: PostListRow[];
  selectedId?: string | null;
  pageSize?: number;
  autoActivateFirst?: boolean;
}) {
  const onActivate = vi.fn<(id: string) => void>();
  composingRef.current = false;
  const { result, rerender } = renderHook(
    (props: { rows: PostListRow[]; selectedId: string | null }) =>
      usePostListbox({
        rows: props.rows,
        selectedId: props.selectedId,
        onActivate,
        pageSize: opts.pageSize ?? 3,
        composingRef,
        autoActivateFirst: opts.autoActivateFirst,
      }),
    { initialProps: { rows: opts.rows, selectedId: opts.selectedId ?? null } },
  );
  const press = (props: Record<string, unknown>) => {
    const k = keyEvent(props);
    act(() => result.current.listboxProps.onKeyDown(k.event));
    return k;
  };
  return { result, rerender, onActivate, press };
}

const THREE = rows(["a", "Apple"], ["b", "Banana"], ["c", "Cherry"]);

describe("usePostListbox — container props", () => {
  it("exposes a single tab stop on the listbox container", () => {
    const { result } = setup({ rows: THREE });
    expect(result.current.listboxProps.role).toBe("listbox");
    expect(result.current.listboxProps.tabIndex).toBe(0);
  });

  it("rows carry option role and reflect the committed selection", () => {
    const { result } = setup({ rows: THREE, selectedId: "b" });
    const props = result.current.getRowProps("b");
    expect(props.role).toBe("option");
    expect(props["aria-selected"]).toBe(true);
    expect(result.current.getRowProps("a")["aria-selected"]).toBe(false);
    // aria-activedescendant points at the selected row (the resting cursor).
    expect(result.current.listboxProps["aria-activedescendant"]).toBe(props.id);
  });

  it("rests on no row when nothing is active or selected", () => {
    const { result } = setup({ rows: THREE });
    expect(result.current.activeId).toBeNull();
    expect(result.current.listboxProps["aria-activedescendant"]).toBeUndefined();
  });

  it("autoActivateFirst rests the cursor on the first row", () => {
    const { result } = setup({ rows: THREE, autoActivateFirst: true });
    expect(result.current.activeId).toBe("a");
  });
});

describe("usePostListbox — keyboard navigation", () => {
  it("ArrowDown from no cursor lands on the first row, then advances", () => {
    const { result, press } = setup({ rows: THREE });
    const k1 = press({ key: "ArrowDown" });
    expect(k1.preventDefault).toHaveBeenCalled();
    expect(result.current.activeId).toBe("a");

    press({ key: "ArrowDown" });
    expect(result.current.activeId).toBe("b");
  });

  it("ArrowUp from no cursor lands on the last row, clamped at the top", () => {
    const { result, press } = setup({ rows: THREE });
    press({ key: "ArrowUp" });
    expect(result.current.activeId).toBe("c");

    press({ key: "ArrowUp" });
    expect(result.current.activeId).toBe("b");
    press({ key: "ArrowUp" });
    expect(result.current.activeId).toBe("a");
    // Stop-at-ends: no wrap past the first row.
    press({ key: "ArrowUp" });
    expect(result.current.activeId).toBe("a");
  });

  it("Home and End jump to the ends", () => {
    const { result, press } = setup({ rows: THREE });
    press({ key: "End" });
    expect(result.current.activeId).toBe("c");
    press({ key: "Home" });
    expect(result.current.activeId).toBe("a");
  });

  it("PageDown/PageUp step by pageSize, clamped to the ends", () => {
    const many = rows(
      ["r0", "0"], ["r1", "1"], ["r2", "2"], ["r3", "3"], ["r4", "4"], ["r5", "5"],
    );
    const { result, press } = setup({ rows: many, pageSize: 3 });
    press({ key: "PageDown" }); // from -1 → max(0,0)+3 = 3
    expect(result.current.activeId).toBe("r3");
    press({ key: "PageDown" }); // 3 + 3 = 6 → clamp to 5
    expect(result.current.activeId).toBe("r5");
    press({ key: "PageUp" }); // 5 - 3 = 2
    expect(result.current.activeId).toBe("r2");
    press({ key: "PageUp" }); // 2 - 3 → clamp to 0
    expect(result.current.activeId).toBe("r0");
  });

  it("does nothing for navigation keys on an empty list", () => {
    const { result, press } = setup({ rows: [] });
    const k = press({ key: "ArrowDown" });
    expect(k.preventDefault).not.toHaveBeenCalled();
    expect(result.current.activeId).toBeNull();
  });
});

describe("usePostListbox — manual activation", () => {
  it("Enter commits the cursor row via onActivate", () => {
    const { onActivate, press } = setup({ rows: THREE });
    press({ key: "ArrowDown" }); // cursor on "a"
    press({ key: "ArrowDown" }); // cursor on "b"
    const k = press({ key: "Enter" });
    expect(k.preventDefault).toHaveBeenCalled();
    expect(onActivate).toHaveBeenCalledWith("b");
  });

  it("Space commits the cursor row", () => {
    const { onActivate, press } = setup({ rows: THREE, selectedId: "c" });
    // The resting cursor is on the selected row "c".
    press({ key: " " });
    expect(onActivate).toHaveBeenCalledWith("c");
  });

  it("Enter does not activate when nothing resolves as the cursor", () => {
    const { onActivate, press } = setup({ rows: THREE });
    press({ key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("guards Enter against an in-progress IME composition", () => {
    const { onActivate, press } = setup({ rows: THREE, selectedId: "a" });
    composingRef.current = true;
    const k = press({ key: "Enter" });
    expect(k.preventDefault).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("clicking a row sets the cursor and commits", () => {
    const { result, onActivate } = setup({ rows: THREE });
    act(() => result.current.getRowProps("c").onClick());
    expect(onActivate).toHaveBeenCalledWith("c");
    expect(result.current.activeId).toBe("c");
  });
});

describe("usePostListbox — type-ahead", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a printable key jumps to the matching label", () => {
    const { result, press } = setup({ rows: THREE });
    press({ key: "b" });
    expect(result.current.activeId).toBe("b");
    // Let the idle window reset the buffer so the next key starts a fresh query.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    press({ key: "c" });
    expect(result.current.activeId).toBe("c");
  });

  it("buffers consecutive keys until the idle reset", () => {
    const data = rows(["1", "Bandana"], ["2", "Banana"], ["3", "Cat"]);
    const { result, press } = setup({ rows: data });
    press({ key: "b" }); // matches "Bandana" (first B)
    expect(result.current.activeId).toBe("1");
    press({ key: "a" }); // "ba" still matches "Bandana"
    press({ key: "n" });
    press({ key: "a" }); // "bana" → "Banana"
    expect(result.current.activeId).toBe("2");

    // After the idle window the buffer resets, so a lone "c" starts fresh.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    press({ key: "c" });
    expect(result.current.activeId).toBe("3");
  });

  it("ignores modified keys and IME composition for type-ahead", () => {
    const { result, press } = setup({ rows: THREE });
    const meta = press({ key: "b", metaKey: true });
    expect(meta.preventDefault).not.toHaveBeenCalled();
    expect(result.current.activeId).toBeNull();

    composingRef.current = true;
    const composing = press({ key: "b" });
    expect(composing.preventDefault).not.toHaveBeenCalled();
    expect(result.current.activeId).toBeNull();
  });
});

describe("usePostListbox — cursor recovery", () => {
  it("moves the cursor to a surviving neighbour when the active row leaves", () => {
    const { result, rerender, press } = setup({ rows: THREE });
    press({ key: "ArrowDown" }); // a
    press({ key: "ArrowDown" }); // b — active
    expect(result.current.activeId).toBe("b");

    // Remove "b" from the rendered set. The cursor recovers to the next row "c".
    act(() => rerender({ rows: rows(["a", "Apple"], ["c", "Cherry"]), selectedId: null }));
    expect(result.current.activeId).toBe("c");
  });

  it("recovers to the new selection when one is present after removal", () => {
    const { result, rerender, press } = setup({ rows: THREE, selectedId: "b" });
    press({ key: "ArrowDown" }); // resolves to selected "b" then moves to ... actually a list
    // Force the cursor onto "b" explicitly.
    act(() => result.current.getRowProps("b").onClick());

    // Remove "b"; selection moves to "a" by the session. The cursor follows it.
    act(() => rerender({ rows: rows(["a", "Apple"], ["c", "Cherry"]), selectedId: "a" }));
    expect(result.current.activeId).toBe("a");
  });

  it("does not recover when the cursor was never moved", () => {
    const { result, rerender } = setup({ rows: THREE, selectedId: "b" });
    // activeId is still null (never navigated); removing rows must not set it.
    act(() => rerender({ rows: rows(["a", "Apple"]), selectedId: "a" }));
    expect(result.current.activeId).toBe("a"); // resolved from selection, not recovery state
  });
});
