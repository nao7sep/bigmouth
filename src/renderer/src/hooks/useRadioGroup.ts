import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { indexOfId, nextIndex } from "../util/compositeNav";

// A manual-activation radiogroup: a single-choice value switch whose commit is
// expensive or destructive. Per the composite-control conventions such a group
// must NOT activate on focus the way a native radio does (arrowing a native
// radio both moves and selects). Here the arrows/Home/End move the active cursor
// ONLY; Space/Enter commits the cursor's value via `onCommit`. Pointer click is a
// deliberate commit. Roving tabindex; the committed `value` is the source of
// truth and the active cursor is the hook's own state.
//
// (No IME composition guard: the focusable elements are buttons, never text
// inputs, so a composition can never be in progress while one is focused — the
// same reason the tablist hook needs none.)

export interface RadioProps {
  role: "radio";
  "aria-checked": boolean;
  tabIndex: 0 | -1;
  ref: (el: HTMLElement | null) => void;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}

export interface UseRadioGroupResult<T extends string> {
  radioGroupProps: { role: "radiogroup" };
  getRadioProps: (value: T) => RadioProps;
}

export function useRadioGroup<T extends string>({
  values,
  value,
  onCommit,
}: {
  values: readonly T[];
  value: T;
  onCommit: (value: T) => void;
}): UseRadioGroupResult<T> {
  const refs = useRef(new Map<T, HTMLElement>());
  const [cursor, setCursor] = useState<T | null>(null);

  // The resting cursor: the explicit one if still valid, else the committed
  // value — so Tab lands on the checked segment.
  const active = cursor != null && values.includes(cursor) ? cursor : value;

  const focusValue = (v: T) => refs.current.get(v)?.focus();

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      const current = indexOfId(values as readonly string[], active);
      let target: T | null = null;
      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          target = values[nextIndex(1, current, values.length)] ?? null;
          break;
        case "ArrowLeft":
        case "ArrowUp":
          target = values[nextIndex(-1, current, values.length)] ?? null;
          break;
        case "Home":
          target = values[0] ?? null;
          break;
        case "End":
          target = values[values.length - 1] ?? null;
          break;
        case "Enter":
        case " ":
          // Manual activation: commit the cursor's value (no-op if it is already
          // the committed one).
          e.preventDefault();
          if (active !== value) onCommit(active);
          return;
        default:
          return;
      }
      // Arrow/Home/End move the cursor only — they never commit.
      e.preventDefault();
      if (target != null) {
        setCursor(target);
        focusValue(target);
      }
    },
    [values, active, value, onCommit],
  );

  const getRadioProps = (v: T): RadioProps => ({
    role: "radio",
    "aria-checked": v === value,
    tabIndex: v === active ? 0 : -1,
    ref: (el) => {
      if (el) refs.current.set(v, el);
      else refs.current.delete(v);
    },
    onClick: () => {
      setCursor(v);
      if (v !== value) onCommit(v);
    },
    onKeyDown,
  });

  return { radioGroupProps: { role: "radiogroup" }, getRadioProps };
}
