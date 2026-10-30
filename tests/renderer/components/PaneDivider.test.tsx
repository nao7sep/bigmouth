import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { PaneDivider } from "@renderer/components/PaneDivider";
import { KEY_RESIZE_SAVE_DELAY_MS } from "@renderer/hooks/useKeyboardResize";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderDivider(sign: 1 | -1 = 1, width = 300) {
  const onWidthChange = vi.fn();
  const onCommitWidth = vi.fn();
  // A drag that saves where it ends, as the panes' own drags do.
  const onMouseDown = vi.fn(() => onCommitWidth(250));
  const parentKeyDown = vi.fn();
  const parentKeyUp = vi.fn();
  const view = render(
    <div onKeyDown={parentKeyDown} onKeyUp={parentKeyUp}>
      <PaneDivider label="Resize" width={width} min={200} max={400} sign={sign}
        onMouseDown={onMouseDown} onWidthChange={onWidthChange} onCommitWidth={onCommitWidth} />
    </div>,
  );
  return { ...view, divider: view.getByRole("separator"), onWidthChange, onCommitWidth, onMouseDown, parentKeyDown, parentKeyUp };
}

describe("PaneDivider keyboard resizing", () => {
  it.each([1, -1] as const)("moves physically left and right with pane sign %s", (sign) => {
    const view = renderDivider(sign);
    fireEvent.keyDown(view.divider, { key: "ArrowRight" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(300 + sign * 16);
    fireEvent.keyDown(view.divider, { key: "ArrowLeft" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(300);
    expect(view.parentKeyDown).not.toHaveBeenCalled();
  });

  it("advances repeats from the latest keyed width before React renders", () => {
    const view = renderDivider();
    act(() => {
      for (let count = 0; count < 3; count += 1) fireEvent.keyDown(view.divider, { key: "ArrowRight", repeat: count > 0 });
    });
    expect(view.onWidthChange.mock.calls.map(([width]) => width)).toEqual([316, 332, 348]);
    expect(view.onCommitWidth).not.toHaveBeenCalled();
    fireEvent.blur(view.divider);
    expect(view.onCommitWidth).toHaveBeenCalledExactlyOnceWith(348);
  });

  // Stepping is continuous editing: the width is saved a short delay after the
  // last step, each step pushing the save back, never once per press.
  it("saves once, a short delay after the last of separate presses", () => {
    vi.useFakeTimers();
    const view = renderDivider();
    for (let count = 0; count < 3; count += 1) {
      fireEvent.keyDown(view.divider, { key: "ArrowRight" });
      fireEvent.keyUp(view.divider, { key: "ArrowRight" });
      act(() => { vi.advanceTimersByTime(KEY_RESIZE_SAVE_DELAY_MS - 1); });
    }
    expect(view.onCommitWidth).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(view.onCommitWidth).toHaveBeenCalledExactlyOnceWith(348);
    fireEvent.blur(view.divider);
    act(() => { vi.advanceTimersByTime(KEY_RESIZE_SAVE_DELAY_MS); });
    expect(view.onCommitWidth).toHaveBeenCalledOnce();
  });

  it("saves a pending step when the divider goes away", () => {
    const view = renderDivider();
    fireEvent.keyDown(view.divider, { key: "ArrowLeft" });
    view.unmount();
    expect(view.onCommitWidth).toHaveBeenCalledExactlyOnceWith(284);
  });

  it.each([1, -1] as const)("uses pane width bounds for Home and End with sign %s", (sign) => {
    const view = renderDivider(sign);
    fireEvent.keyDown(view.divider, { key: "Home" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(200);
    fireEvent.keyDown(view.divider, { key: sign === 1 ? "ArrowLeft" : "ArrowRight" });
    expect(view.onWidthChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(view.divider, { key: "End" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(400);
    fireEvent.keyDown(view.divider, { key: sign === 1 ? "ArrowRight" : "ArrowLeft" });
    expect(view.onWidthChange).toHaveBeenCalledTimes(2);
    fireEvent.blur(view.divider);
    expect(view.onCommitWidth).toHaveBeenCalledExactlyOnceWith(400);
  });

  it("clamps an arrow crossing a configured bound", () => {
    const view = renderDivider(1, 395);
    fireEvent.keyDown(view.divider, { key: "ArrowRight" });
    expect(view.onWidthChange).toHaveBeenCalledExactlyOnceWith(400);
  });

  it("does not change or persist a no-op at a bound", () => {
    const view = renderDivider(1, 200);
    fireEvent.keyDown(view.divider, { key: "Home" });
    fireEvent.keyDown(view.divider, { key: "ArrowLeft" });
    fireEvent.keyUp(view.divider, { key: "ArrowLeft" });
    fireEvent.blur(view.divider);
    expect(view.onWidthChange).not.toHaveBeenCalled();
    expect(view.onCommitWidth).not.toHaveBeenCalled();
  });

  it("keeps unrelated keys available and saves a pending resize on blur", () => {
    const view = renderDivider();
    fireEvent.keyDown(view.divider, { key: "ArrowRight" });
    fireEvent.keyUp(view.divider, { key: "Shift" });
    expect(view.onCommitWidth).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(view.divider, { key: "Tab" })).toBe(true);
    expect(view.parentKeyDown).toHaveBeenCalledOnce();
    fireEvent.blur(view.divider);
    expect(view.onCommitWidth).toHaveBeenCalledExactlyOnceWith(316);
  });

  it("saves a pending step before a drag starts, so the drag's width is saved last", () => {
    vi.useFakeTimers();
    const view = renderDivider();
    fireEvent.keyDown(view.divider, { key: "ArrowRight" });
    fireEvent.mouseDown(view.divider);
    expect(view.onCommitWidth.mock.calls).toEqual([[316], [250]]);
    act(() => { vi.advanceTimersByTime(KEY_RESIZE_SAVE_DELAY_MS); });
    fireEvent.blur(view.divider);
    expect(view.onCommitWidth).toHaveBeenCalledTimes(2);
  });

  it("steps from the drag's width after a drag, not from an earlier keyed one", () => {
    const view = renderDivider();
    fireEvent.keyDown(view.divider, { key: "ArrowRight" });
    fireEvent.mouseDown(view.divider);
    view.rerender(
      <div>
        <PaneDivider label="Resize" width={250} min={200} max={400} sign={1}
          onMouseDown={view.onMouseDown} onWidthChange={view.onWidthChange} onCommitWidth={view.onCommitWidth} />
      </div>,
    );
    fireEvent.keyDown(view.divider, { key: "ArrowRight" });
    expect(view.onWidthChange).toHaveBeenLastCalledWith(266);
  });
});
