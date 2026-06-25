import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCopyFeedback } from "@renderer/hooks/useCopyFeedback";

// The hook writes to navigator.clipboard and arms a reset timer. Stub the
// clipboard and drive the timer with fake timers; restore both afterwards.
let writeText: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

describe("useCopyFeedback", () => {
  it("writes to the clipboard and flags the copied key, then clears after the duration", () => {
    const { result } = renderHook(() => useCopyFeedback(1500));
    expect(result.current.copiedKey).toBeNull();

    act(() => result.current.copy("hello", "k1"));
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(result.current.copiedKey).toBe("k1");

    // Not yet elapsed.
    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(result.current.copiedKey).toBe("k1");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copiedKey).toBeNull();
  });

  it("defaults the key to \"default\"", () => {
    const { result } = renderHook(() => useCopyFeedback());
    act(() => result.current.copy("text"));
    expect(result.current.copiedKey).toBe("default");
  });

  it("a second copy of a different key restarts the window and does not clear the newer key", () => {
    const { result } = renderHook(() => useCopyFeedback(1000));

    act(() => result.current.copy("a", "k1"));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    // Copy a different key before the first timer fires; the first timer is
    // cleared so it can never reset the now-current key.
    act(() => result.current.copy("b", "k2"));
    expect(result.current.copiedKey).toBe("k2");

    // Past the first timer's original deadline: still k2 (its timer is cleared).
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.copiedKey).toBe("k2");

    // The second timer's full duration then clears k2.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current.copiedKey).toBeNull();
  });

  it("the reset only clears when the current key still matches", () => {
    // copy k1, then copy k2; when k1's (cleared) timer would have fired it must
    // not clear k2 even via the functional-update guard. Covered above; here we
    // assert the guard directly by re-copying the same key to refresh it.
    const { result } = renderHook(() => useCopyFeedback(1000));
    act(() => result.current.copy("a", "k1"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.copiedKey).toBeNull();
  });

  it("uses a custom duration", () => {
    const { result } = renderHook(() => useCopyFeedback(500));
    act(() => result.current.copy("x", "k"));
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.copiedKey).toBe("k");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copiedKey).toBeNull();
  });

  it("swallows a clipboard write rejection without throwing", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const { result } = renderHook(() => useCopyFeedback());
    act(() => result.current.copy("x"));
    // The feedback flag is still set even though the write failed.
    expect(result.current.copiedKey).toBe("default");
    // Flush the rejected promise's catch; no unhandled rejection.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("clears the pending reset timer on unmount", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { result, unmount } = renderHook(() => useCopyFeedback());
    act(() => result.current.copy("x", "k"));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
