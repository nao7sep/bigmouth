// Which failed Claude calls are resent, and how long the app waits first (the
// store-and-model alignment's rule for calling a provider).

import { describe, expect, it, vi } from "vitest";

import { MAX_ATTEMPTS, RETRY_AFTER_CAP_MS, isRetryable, retryDelayMs, waitFor } from "@main/core/ai/retryPolicy.js";

function status(code: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`${code}`), { status: code, headers: new Headers(headers) });
}

// The SDK wraps a fetch failure as a connection error whose cause is undici's
// TypeError, whose own cause carries the socket's code.
function connection(code: string) {
  return Object.assign(new Error("Connection error."), {
    cause: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) }),
  });
}

describe("isRetryable", () => {
  it("resends only what the provider refused or never received", () => {
    for (const code of [408, 429, 503]) expect(isRetryable(status(code)), String(code)).toBe(true);
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) expect(isRetryable(connection(code)), code).toBe(true);
  });

  it("reports a failure with an unknown or final outcome instead", () => {
    for (const code of [400, 401, 404, 500, 502, 504, 529]) expect(isRetryable(status(code)), String(code)).toBe(false);
    expect(isRetryable(connection("ECONNRESET"))).toBe(false);
    expect(isRetryable(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }))).toBe(false);
    expect(isRetryable(new Error("Request was aborted."))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });

  it("allows three attempts in all", () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

describe("retryDelayMs", () => {
  it("honours Retry-After in seconds or as a date, capped at 30 seconds", () => {
    expect(retryDelayMs(status(429, { "retry-after": "4" }), 1)).toBe(4_000);
    expect(retryDelayMs(status(429, { "retry-after": "120" }), 1)).toBe(RETRY_AFTER_CAP_MS);
    const now = Date.parse("2026-10-04T00:00:00Z");
    expect(retryDelayMs(status(503, { "retry-after": "Sun, 04 Oct 2026 00:00:07 GMT" }), 1, now)).toBe(7_000);
    expect(retryDelayMs(status(503, { "retry-after": "Sat, 03 Oct 2026 23:00:00 GMT" }), 1, now)).toBe(0);
  });

  it("falls back to the app's own backoff", () => {
    expect(retryDelayMs(status(503), 1)).toBe(2_000);
    expect(retryDelayMs(status(503), 2)).toBe(5_000);
    expect(retryDelayMs(connection("ECONNREFUSED"), 1)).toBe(2_000);
    expect(retryDelayMs(status(429, { "retry-after": "soon" }), 2)).toBe(5_000);
  });
});

describe("waitFor", () => {
  it("resolves after the delay, or rejects as soon as the signal aborts", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      void waitFor(1_000, new AbortController().signal).then(done);
      await vi.advanceTimersByTimeAsync(999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledOnce();

      const stop = new AbortController();
      const waiting = waitFor(60_000, stop.signal);
      stop.abort(new Error("stopped"));
      await expect(waiting).rejects.toThrow("stopped");
      await expect(waitFor(1, stop.signal)).rejects.toThrow("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});
