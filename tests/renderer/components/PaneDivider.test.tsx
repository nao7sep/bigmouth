import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { PaneDivider } from "@renderer/components/PaneDivider";

afterEach(cleanup);

function renderDivider(sign: 1 | -1 = 1, width = 300) {
  const onWidthChange = vi.fn();
  const onCommitWidth = vi.fn();
  const parentKeyDown = vi.fn();
  const parentKeyUp = vi.fn();
  const view = render(
    <div onKeyDown={parentKeyDown} onKeyUp={parentKeyUp}>
      <PaneDivider label="Resize" width={width} min={200} max={400} sign={sign}
        onMouseDown={vi.fn()} onWidthChange={onWidthChange} onCommitWidth={onCommitWidth} />
    </div>,
  );
  return { ...view, divider: view.getByRole("separator"), onWidthChange, onCommitWidth, parentKeyDown, parentKeyUp };
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
    fireEvent.keyUp(view.divider, { key: "ArrowRight" });
    fireEvent.blur(view.divider);
    expect(view.onCommitWidth).toHaveBeenCalledExactlyOnceWith(348);
    expect(view.parentKeyUp).not.toHaveBeenCalled();
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
});
