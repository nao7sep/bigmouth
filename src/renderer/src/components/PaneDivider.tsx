import { useRef } from "react";
import type { KeyboardEvent, MouseEventHandler } from "react";
import { clamp } from "../paneConstants";

// Match the Records window's divider movement.
const KEY_RESIZE_STEP = 16;

interface PaneDividerProps {
  label: string;
  width: number;
  min: number;
  max: number;
  sign: 1 | -1;
  onMouseDown: MouseEventHandler<HTMLDivElement>;
  onWidthChange: (width: number) => void;
  onCommitWidth: (width: number) => void;
}

export function PaneDivider({ label, width, min, max, sign, onMouseDown, onWidthChange, onCommitWidth }: PaneDividerProps) {
  // A held key advances from the last intent, even before its render and when
  // the viewport fits the displayed pane to a smaller width.
  const keyedWidth = useRef<number | null>(null);
  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
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
  };
  const commitWidth = () => {
    if (keyedWidth.current === null) return;
    const width = keyedWidth.current;
    keyedWidth.current = null;
    onCommitWidth(width);
  };

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onKeyDown={resizeByKey}
      onKeyUp={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.stopPropagation();
        commitWidth();
      }}
      onBlur={commitWidth}
    />
  );
}
