import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
} from "react";
import {
  currentCompositeIndex,
  indexOfId,
  nextIndex,
  removalFocusTargetId,
  typeAheadMatch,
  type NavDirection,
} from "../util/compositeNav";
import { isComposingKeyboardEvent } from "./useComposing";

// The app's listbox layer: one shared hook behind the post list. It realizes
// the composite-control contract for a grouped, single-select listbox:
//
//   - One tab stop: the `role="listbox"` container holds focus (tabIndex 0) and
//     points at the active row with `aria-activedescendant`. Rows are not
//     themselves focusable, so a row leaving the set can never drop DOM focus to
//     <body> — the container keeps focus and the keyboard throughout.
//   - Up/Down/Home/End/PageUp/PageDown move the active cursor (scrolled into
//     view as it moves); stop-at-ends.
//   - Type-ahead by row label, composition-guarded for IME.
//   - MANUAL activation: arrows move only the cursor; Enter/Space commit via
//     `onActivate`. Committing a post flushes/can-discard in-progress editor
//     state, so it must not fire on every keystroke.
//   - The active cursor (hook-owned `activeId`) and the committed selection
//     (`selectedId`, the app's source of truth) are separate state.
//   - Recovery: when the active row leaves the rendered set, the cursor moves to
//     the surviving neighbour. No focus juggling is needed — focus never left
//     the container.
//
// Group headers, collapse toggles, and "load more" are not the listbox's
// concern — the caller renders them outside the row sequence (see LeftPane).

const TYPE_AHEAD_RESET_MS = 700;

export interface PostListRow {
  id: string;
  label: string;
}

export interface PostRowProps {
  role: "option";
  "aria-selected": boolean;
  id: string;
  ref: (el: HTMLElement | null) => void;
  onClick: () => void;
}

export interface UsePostListboxResult {
  /** Props for the `role="listbox"` container. */
  listboxProps: {
    role: "listbox";
    ref: RefObject<HTMLDivElement | null>;
    tabIndex: 0;
    "aria-activedescendant"?: string;
    onKeyDown: (e: ReactKeyboardEvent) => void;
  };
  /** Props for one option row. */
  getRowProps: (id: string) => PostRowProps;
  /** The id the keyboard cursor is currently on (for styling the active row). */
  activeId: string | null;
}

/**
 * Drives the post listbox over the flat `rows` (group-flattened, in display
 * order). `selectedId` is the committed selection from the session; `onActivate`
 * commits a new selection (manual activation). `pageSize` is the PageUp/PageDown
 * step. `composingRef` guards type-ahead and activation against IME composition.
 */
export function usePostListbox({
  rows,
  selectedId,
  onActivate,
  pageSize,
  composingRef,
  autoActivateFirst = false,
}: {
  rows: readonly PostListRow[];
  selectedId: string | null;
  onActivate: (id: string) => void;
  pageSize: number;
  composingRef: RefObject<boolean>;
  /**
   * When nothing is active or selected, make the first row the resting cursor
   * (and tab stop). Suits a picker, where there is no committed selection and
   * the user expects Tab/arrow to land straight on a row. Off by default so a
   * list with a real selection (the post list) leaves the cursor where the
   * selection is, and an unselected one rests on the container.
   */
  autoActivateFirst?: boolean;
}): UsePostListboxResult {
  const baseId = useId();
  const rowDomId = useCallback((id: string) => `${baseId}-opt-${id}`, [baseId]);
  const listboxRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const [activeId, setActiveId] = useState<string | null>(null);

  const ids = rows.map((r) => r.id);
  const labels = rows.map((r) => r.label);

  // The cursor index, resolved from the hook's own active id, falling back to
  // the committed selection so Tab into the list lands on the selected row.
  const activeIndex = currentCompositeIndex({ ids, activeId, selectedId });
  const resolvedActiveId =
    activeIndex !== -1
      ? ids[activeIndex]
      : autoActivateFirst && ids.length > 0
        ? ids[0]
        : null;

  // Focus stays on the container; moving the cursor only scrolls the active row
  // into view (aria-activedescendant carries the cursor for assistive tech).
  const scrollActiveIntoView = useCallback((id: string) => {
    rowRefs.current.get(id)?.scrollIntoView({ block: "nearest" });
  }, []);

  // Recovery. When the rendered rows change such that the row the user was on
  // has left the set (deleted, archived, status-changed out of view), the cursor
  // moves to the surviving neighbour. Selection recovery is the session's job —
  // it has already moved `selectedId` via `pickAdjacentPostId`, so the resolved
  // cursor below already points there; `removalFocusTargetId` from the pre-change
  // order is the fallback when it did not. There is no focus to restore: DOM
  // focus lives on the container, which does not unmount when a row leaves.
  const prevRowsRef = useRef<readonly PostListRow[]>(rows);
  useLayoutEffect(() => {
    const prevRows = prevRowsRef.current;
    prevRowsRef.current = rows;

    if (activeId == null) return; // never navigated yet; nothing to recover
    if (indexOfId(ids, activeId) !== -1) return; // active row still present

    const neighbour =
      indexOfId(ids, selectedId) !== -1
        ? selectedId
        : removalFocusTargetId(prevRows.map((r) => r.id), activeId);
    setActiveId(neighbour);
    if (neighbour != null) scrollActiveIntoView(neighbour);
  }, [rows]);

  // Type-ahead buffer with idle reset.
  const queryRef = useRef("");
  const queryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (queryTimerRef.current != null) clearTimeout(queryTimerRef.current);
    },
    [],
  );

  const moveTo = useCallback(
    (index: number) => {
      if (index < 0 || index >= ids.length) return;
      const id = ids[index];
      setActiveId(id);
      scrollActiveIntoView(id);
    },
    [ids, scrollActiveIntoView],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (ids.length === 0) return;

      const move = (direction: NavDirection) => {
        e.preventDefault();
        moveTo(nextIndex(direction, activeIndex, ids.length));
      };

      switch (e.key) {
        case "ArrowDown":
          move(1);
          return;
        case "ArrowUp":
          move(-1);
          return;
        case "Home":
          e.preventDefault();
          moveTo(0);
          return;
        case "End":
          e.preventDefault();
          moveTo(ids.length - 1);
          return;
        case "PageDown":
          e.preventDefault();
          moveTo(Math.min(ids.length - 1, Math.max(0, activeIndex) + pageSize));
          return;
        case "PageUp":
          e.preventDefault();
          moveTo(Math.max(0, Math.max(0, activeIndex) - pageSize));
          return;
        case "Enter":
        case " ":
          // Manual activation: commit the cursor row. Guard IME so the Enter
          // that confirms a composition does not also activate.
          if (isComposingKeyboardEvent(composingRef, e)) return;
          e.preventDefault();
          if (resolvedActiveId != null) onActivate(resolvedActiveId);
          return;
        default:
          break;
      }

      // Type-ahead: a single printable character, no modifiers, not mid-IME.
      if (
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isComposingKeyboardEvent(composingRef, e)
      ) {
        e.preventDefault();
        queryRef.current += e.key;
        if (queryTimerRef.current != null) clearTimeout(queryTimerRef.current);
        queryTimerRef.current = setTimeout(() => {
          queryRef.current = "";
        }, TYPE_AHEAD_RESET_MS);

        const match = typeAheadMatch(labels, activeIndex, queryRef.current);
        if (match !== -1) moveTo(match);
      }
    },
    [
      ids,
      labels,
      activeIndex,
      resolvedActiveId,
      pageSize,
      moveTo,
      onActivate,
      composingRef,
    ],
  );

  const getRowProps = useCallback(
    (id: string): PostRowProps => ({
      role: "option",
      "aria-selected": id === selectedId,
      // A stable DOM id so the container's aria-activedescendant can point here.
      id: rowDomId(id),
      ref: (el) => {
        if (el) rowRefs.current.set(id, el);
        else rowRefs.current.delete(id);
      },
      onClick: () => {
        // Pointer parity: clicking sets the cursor and commits, mirroring Enter
        // on a row. Focus moves to the container so subsequent arrows continue.
        setActiveId(id);
        listboxRef.current?.focus();
        onActivate(id);
      },
      // Key handling lives on the container (listboxProps.onKeyDown), which is
      // the focus holder; rows are not focusable.
    }),
    [selectedId, rowDomId, onActivate],
  );

  return {
    listboxProps: {
      role: "listbox",
      ref: listboxRef,
      // The container is the single, permanent tab stop and focus holder; the
      // active row is conveyed via aria-activedescendant rather than by moving
      // DOM focus into the rows.
      tabIndex: 0,
      "aria-activedescendant": resolvedActiveId != null ? rowDomId(resolvedActiveId) : undefined,
      onKeyDown,
    },
    getRowProps,
    activeId: resolvedActiveId,
  };
}
