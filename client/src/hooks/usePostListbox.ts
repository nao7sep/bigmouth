import {
  useCallback,
  useEffect,
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
//   - One tab stop (roving tabindex): the active row carries tabIndex 0, every
//     other row tabIndex -1; the container is focusable when the list is empty.
//   - Up/Down/Home/End/PageUp/PageDown move the active cursor; stop-at-ends.
//   - Type-ahead by row label, composition-guarded for IME.
//   - MANUAL activation: arrows move only the cursor; Enter/Space commit via
//     `onActivate`. Committing a post flushes/can-discard in-progress editor
//     state, so it must not fire on every keystroke.
//   - The active cursor (hook-owned `activeId`) and the committed selection
//     (`selectedId`, the app's source of truth) are separate state.
//   - Recovery: when the active row leaves the rendered set while focus is in
//     the list, focus moves to the surviving neighbour before paint; if focus
//     has left the list, state updates silently (never steal focus).
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
  tabIndex: 0 | -1;
  ref: (el: HTMLElement | null) => void;
  onClick: () => void;
}

export interface UsePostListboxResult {
  /** Props for the `role="listbox"` container. */
  listboxProps: {
    role: "listbox";
    ref: RefObject<HTMLDivElement | null>;
    tabIndex?: 0;
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

  const focusRow = useCallback((id: string) => {
    rowRefs.current.get(id)?.focus();
  }, []);

  // Recovery + never-steal-focus. When the rendered rows change such that the
  // row the user was on has left the set (deleted, archived, status-changed out
  // of view), two things must happen. Selection recovery is the session's job:
  // it has already moved `selectedId` to the surviving neighbour via
  // `pickAdjacentPostId`, so the resolved cursor below already points there.
  // What the listbox owns is FOCUS recovery: the unmounted focused row has
  // dropped DOM focus to <body>, and this layout effect — which runs after the
  // commit but before paint, so the move is invisible — restores focus to the
  // recovered cursor row.
  //
  // `removalFocusTargetId` from the pre-change order is the fallback for when
  // the session did not (or could not) move selection: it picks the same
  // next-then-previous neighbour at the id level.
  const prevRowsRef = useRef<readonly PostListRow[]>(rows);
  useLayoutEffect(() => {
    const prevRows = prevRowsRef.current;
    prevRowsRef.current = rows;

    if (activeId == null) return; // never navigated yet; nothing to recover
    if (indexOfId(ids, activeId) !== -1) return; // active row still present

    // The active row left the rendered set. Adopt the session's recovered
    // selection if it is in view, else the pre-change neighbour.
    const neighbour =
      indexOfId(ids, selectedId) !== -1
        ? selectedId
        : removalFocusTargetId(prevRows.map((r) => r.id), activeId);
    setActiveId(neighbour);

    // Never steal focus: only take DOM focus when the list had it. The unmounted
    // focused row leaves focus on <body>; that is our "focus was inside" signal.
    if (neighbour != null && document.activeElement === document.body) {
      // Defer until the recovered row has received its roving tabIndex=0.
      queueMicrotask(() => {
        if (document.activeElement === document.body) focusRow(neighbour);
      });
    }
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
      focusRow(id);
    },
    [ids, focusRow],
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
      tabIndex: id === resolvedActiveId ? 0 : -1,
      ref: (el) => {
        if (el) rowRefs.current.set(id, el);
        else rowRefs.current.delete(id);
      },
      onClick: () => {
        // Pointer parity: clicking sets the cursor and commits, mirroring
        // Enter on a row. Focus follows so subsequent arrows continue from here.
        setActiveId(id);
        focusRow(id);
        onActivate(id);
      },
      // Key handling lives on the container (listboxProps.onKeyDown): a row's
      // keydown bubbles up to it, so one handler serves both the focused row and
      // the empty-list container — and never double-fires.
    }),
    [selectedId, resolvedActiveId, focusRow, onActivate],
  );

  return {
    listboxProps: {
      role: "listbox",
      ref: listboxRef,
      // The control must always have exactly one tab stop. When a row is the
      // resting cursor it carries tabIndex 0; otherwise (an empty list, or a
      // non-empty list with nothing active/selected) the container itself is the
      // tab stop, and the first arrow press enters the rows.
      tabIndex: resolvedActiveId == null ? 0 : undefined,
      onKeyDown,
    },
    getRowProps,
    activeId: resolvedActiveId,
  };
}
