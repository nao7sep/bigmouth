import type { MouseEventHandler } from "react";
import { useKeyboardResize } from "../hooks/useKeyboardResize";

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
  const { onKeyDown, onBlur } = useKeyboardResize({ width, min, max, sign, onWidthChange, onCommitWidth });

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
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}
