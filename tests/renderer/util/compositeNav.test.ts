import { describe, it, expect } from "vitest";
import {
  nextIndex,
  indexOfId,
  currentCompositeIndex,
  removalFocusTargetId,
  typeAheadMatch,
  flatPostListIds,
} from "../../src/util/compositeNav";

// These are the pure navigation helpers behind every composite control. The
// DOM-facing behaviour they enable (roving focus, focus landing after a move,
// type-ahead actually moving the cursor, the menu's focus return) is DOM-only
// and verified by manual QA — see the README/plan. Here we test only the
// arithmetic and string matching, which is where the bugs hide.

describe("nextIndex", () => {
  it("steps down and up within bounds", () => {
    expect(nextIndex(1, 0, 3)).toBe(1);
    expect(nextIndex(1, 1, 3)).toBe(2);
    expect(nextIndex(-1, 2, 3)).toBe(1);
    expect(nextIndex(-1, 1, 3)).toBe(0);
  });

  it("stops at the ends (no wrap)", () => {
    expect(nextIndex(1, 2, 3)).toBe(2); // already last, Down stays
    expect(nextIndex(-1, 0, 3)).toBe(0); // already first, Up stays
  });

  it("enters the list from -1: Down lands first, Up lands last", () => {
    expect(nextIndex(1, -1, 3)).toBe(0);
    expect(nextIndex(-1, -1, 3)).toBe(2);
  });

  it("handles a single-item list", () => {
    expect(nextIndex(1, 0, 1)).toBe(0);
    expect(nextIndex(-1, 0, 1)).toBe(0);
    expect(nextIndex(1, -1, 1)).toBe(0);
    expect(nextIndex(-1, -1, 1)).toBe(0);
  });

  it("returns -1 for an empty list", () => {
    expect(nextIndex(1, -1, 0)).toBe(-1);
    expect(nextIndex(-1, 0, 0)).toBe(-1);
  });
});

describe("indexOfId", () => {
  it("finds an id or returns -1", () => {
    expect(indexOfId(["a", "b", "c"], "b")).toBe(1);
    expect(indexOfId(["a", "b", "c"], "z")).toBe(-1);
  });

  it("treats null/undefined as absent", () => {
    expect(indexOfId(["a"], null)).toBe(-1);
    expect(indexOfId(["a"], undefined)).toBe(-1);
  });
});

describe("currentCompositeIndex", () => {
  const ids = ["a", "b", "c"];

  it("prefers the active cursor over everything else", () => {
    expect(
      currentCompositeIndex({ ids, activeId: "c", focusedId: "a", selectedId: "b" }),
    ).toBe(2);
  });

  it("falls back to the focused id when no active cursor", () => {
    expect(
      currentCompositeIndex({ ids, activeId: null, focusedId: "b", selectedId: "a" }),
    ).toBe(1);
  });

  it("falls back to the committed selection when neither active nor focused", () => {
    expect(
      currentCompositeIndex({ ids, activeId: null, focusedId: null, selectedId: "c" }),
    ).toBe(2);
  });

  it("returns -1 when nothing resolves so the first arrow enters the list", () => {
    expect(currentCompositeIndex({ ids, activeId: null, selectedId: null })).toBe(-1);
  });

  it("ignores stale ids that have left the list at each precedence level", () => {
    // active is stale → fall through to selected
    expect(
      currentCompositeIndex({ ids, activeId: "gone", selectedId: "a" }),
    ).toBe(0);
    // active and focused stale → selected
    expect(
      currentCompositeIndex({ ids, activeId: "x", focusedId: "y", selectedId: "b" }),
    ).toBe(1);
    // everything stale → -1
    expect(
      currentCompositeIndex({ ids, activeId: "x", focusedId: "y", selectedId: "z" }),
    ).toBe(-1);
  });
});

describe("removalFocusTargetId", () => {
  it("picks the next item when one follows", () => {
    expect(removalFocusTargetId(["a", "b", "c"], "b")).toBe("c");
    expect(removalFocusTargetId(["a", "b", "c"], "a")).toBe("b");
  });

  it("picks the previous item when removing the last", () => {
    expect(removalFocusTargetId(["a", "b", "c"], "c")).toBe("b");
  });

  it("returns null when the removed item was the only one", () => {
    expect(removalFocusTargetId(["a"], "a")).toBeNull();
  });

  it("returns null when the id is not in the list", () => {
    expect(removalFocusTargetId(["a", "b"], "z")).toBeNull();
  });
});

describe("typeAheadMatch", () => {
  const labels = ["Apple", "apricot", "Banana", "cherry"];

  it("matches case-insensitively by prefix", () => {
    expect(typeAheadMatch(labels, -1, "ban")).toBe(2);
    expect(typeAheadMatch(labels, -1, "CH")).toBe(3);
  });

  it("searches forward from just after the cursor", () => {
    // From "Apple" (0), "a" should land on the next a-item, "apricot".
    expect(typeAheadMatch(labels, 0, "a")).toBe(1);
  });

  it("wraps once so a match behind the cursor is still found", () => {
    // From "cherry" (3), "a" wraps to "Apple" (0).
    expect(typeAheadMatch(labels, 3, "a")).toBe(0);
  });

  it("returns -1 for no match or an empty query", () => {
    expect(typeAheadMatch(labels, -1, "zzz")).toBe(-1);
    expect(typeAheadMatch(labels, 0, "")).toBe(-1);
  });
});

describe("flatPostListIds", () => {
  it("flattens expanded groups in declared order, crossing group boundaries", () => {
    expect(
      flatPostListIds([
        { open: true, items: ["d1", "d2"] },
        { open: true, items: ["c1"] },
        { open: true, items: ["p1", "p2"] },
      ]),
    ).toEqual(["d1", "d2", "c1", "p1", "p2"]);
  });

  it("drops the items of a collapsed group entirely", () => {
    expect(
      flatPostListIds([
        { open: true, items: ["d1"] },
        { open: false, items: ["c1", "c2"] }, // collapsed → contributes nothing
        { open: true, items: ["p1"] },
      ]),
    ).toEqual(["d1", "p1"]);
  });

  it("returns an empty sequence when every group is collapsed or empty", () => {
    expect(
      flatPostListIds([
        { open: false, items: ["a"] },
        { open: true, items: [] },
      ]),
    ).toEqual([]);
  });

  it("works on object items, preserving identity", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    expect(
      flatPostListIds([
        { open: true, items: [a] },
        { open: false, items: [b] },
      ]),
    ).toEqual([a]);
  });
});
