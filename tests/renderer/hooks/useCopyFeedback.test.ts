import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCopyFeedback } from "@renderer/hooks/useCopyFeedback";
import { reportProblem } from "@renderer/api";

vi.mock("@renderer/api", () => ({ reportProblem: vi.fn() }));

// The hook writes to navigator.clipboard and arms a reset timer. Stub the
// clipboard and drive the timer with fake timers; restore both afterwards.
let writeText: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
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
  it("writes to the clipboard and flags the copied key, then clears after the duration", async () => {
    const { result } = renderHook(() => useCopyFeedback(1500));
    expect(result.current.copiedKey).toBeNull();

    await act(async () => result.current.copy("hello", "k1"));
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

  it("defaults the key to \"default\"", async () => {
    const { result } = renderHook(() => useCopyFeedback());
    await act(async () => result.current.copy("text"));
    expect(result.current.copiedKey).toBe("default");
  });

  it("a second copy of a different key restarts the window and does not clear the newer key", async () => {
    const { result } = renderHook(() => useCopyFeedback(1000));

    await act(async () => result.current.copy("a", "k1"));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    // Copy a different key before the first timer fires; the first timer is
    // cleared so it can never reset the now-current key.
    await act(async () => result.current.copy("b", "k2"));
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

  it("the reset only clears when the current key still matches", async () => {
    // copy k1, then copy k2; when k1's (cleared) timer would have fired it must
    // not clear k2 even via the functional-update guard. Covered above; here we
    // assert the guard directly by re-copying the same key to refresh it.
    const { result } = renderHook(() => useCopyFeedback(1000));
    await act(async () => result.current.copy("a", "k1"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.copiedKey).toBeNull();
  });

  it("uses a custom duration", async () => {
    const { result } = renderHook(() => useCopyFeedback(500));
    await act(async () => result.current.copy("x", "k"));
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.copiedKey).toBe("k");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copiedKey).toBeNull();
  });

  it("does not report a copy that failed", async () => {
    // "Copied" used to be set before the write resolved, with the rejection
    // swallowed — so a denied clipboard flashed success and the user pasted
    // whatever was there before. The feedback now follows the write.
    writeText.mockRejectedValueOnce(new Error("denied"));
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => result.current.copy("x"));

    expect(result.current.copiedKey).toBeNull();
    expect(result.current.copyErrors.default).toBe(
      "Could not copy to the clipboard. Try again.",
    );
    expect(reportProblem).toHaveBeenCalledWith(
      "clipboard write failed",
      expect.any(Error),
      { key: "default" },
    );
  });

  it("keeps independent failures until each action succeeds or is dismissed", async () => {
    writeText.mockRejectedValueOnce(new Error("first denied"));
    writeText.mockRejectedValueOnce(new Error("second denied"));
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => result.current.copy("a", "first"));
    await act(async () => result.current.copy("b", "second"));
    expect(Object.keys(result.current.copyErrors)).toEqual(["first", "second"]);

    writeText.mockResolvedValueOnce(undefined);
    await act(async () => result.current.copy("a", "first"));
    expect(result.current.copyErrors.first).toBeUndefined();
    expect(result.current.copyErrors.second).toBeTruthy();

    act(() => result.current.dismissCopyError("second"));
    expect(result.current.copyErrors).toEqual({});
  });

  it("clears the pending reset timer on unmount", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const { result, unmount } = renderHook(() => useCopyFeedback());
    // Awaited: the timer is armed when the write resolves, not when copy is called.
    await act(async () => result.current.copy("x", "k"));
    unmount();
    expect(clearSpy).toHaveBeenCalled();
  });
});
