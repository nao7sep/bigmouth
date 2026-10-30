import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { clamp } from "../paneConstants";

// How far one arrow press moves a divider.
const KEY_RESIZE_STEP = 16;
// Arrow steps are continuous editing (unsaved-edits-conventions): the width is
// saved this long after the last step, and each step pushes the save back, so
// a run of presses or a held key writes once.
export const KEY_RESIZE_SAVE_DELAY_MS = 500;

interface KeyboardResize {
  width: number;
  min: number;
  max: number;
  /** 1 when ArrowRight widens the pane, -1 when it narrows it. */
  sign: 1 | -1;
  onWidthChange: (width: number) => void;
  onCommitWidth: (width: number) => void;
}

/**
 * A divider's keyboard resizing (the window splitter pattern): the arrows move
 * it a step, Home and End take it to either bound. The width shows at once and
 * is saved after the last step, or as focus leaves or the divider goes away.
 */
export function useKeyboardResize({ width, min, max, sign, onWidthChange, onCommitWidth }: KeyboardResize) {
  // A run of steps advances from the last intent, even before its render and
  // when the viewport fits the displayed pane to a smaller width.
  const keyedWidth = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = useRef(onCommitWidth);
  commit.current = onCommitWidth;

  const save = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (keyedWidth.current === null) return;
    const saved = keyedWidth.current;
    keyedWidth.current = null;
    commit.current(saved);
  }, []);
  useEffect(() => save, [save]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const from = keyedWidth.current ?? width;
    const target = event.key === "ArrowLeft" ? from - sign * KEY_RESIZE_STEP
      : event.key === "ArrowRight" ? from + sign * KEY_RESIZE_STEP
      : event.key === "Home" ? min
      : event.key === "End" ? max
      : null;
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    const next = clamp(target, min, max);
    if (next === from) return;
    keyedWidth.current = next;
    onWidthChange(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(save, KEY_RESIZE_SAVE_DELAY_MS);
  };

  return { onKeyDown, onBlur: save };
}
