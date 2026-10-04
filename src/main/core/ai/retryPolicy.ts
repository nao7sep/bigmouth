/**
 * Which failed Claude calls the app resends, and when. Only a call the provider
 * refused or never received is resent: a refused or unresolved connection, 408,
 * 429 and 503. A timeout, a dropped connection, and any other status have an
 * unknown or final outcome and reach the waiting user instead, whose run button
 * is the retry. The SDK's own retries stay off, so this is the only loop.
 */

/** Attempts per call, the first included; bigmouth has no retry setting. */
export const MAX_ATTEMPTS = 3;
/** The app's backoff before the second and third attempts, when no Retry-After says otherwise. */
export const RETRY_DELAYS_MS = [2_000, 5_000] as const;
export const RETRY_AFTER_CAP_MS = 30_000;

const RETRY_STATUSES = new Set([408, 429, 503]);
// A connection refused, or a host name that did not resolve: nothing was received.
const UNSENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

function causeCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** Whether a failed attempt may be sent again. */
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return RETRY_STATUSES.has(status);
  return causeCodes(err).some((code) => UNSENT_CODES.has(code));
}

/**
 * The wait before the attempt after `attempt` (1-based): the provider's
 * Retry-After, capped, where it sent one, else the app's backoff.
 */
export function retryDelayMs(err: unknown, attempt: number, now: number = Date.now()): number {
  const headers = (err as { headers?: unknown } | null)?.headers;
  const value = headers instanceof Headers ? headers.get("retry-after") : null;
  if (value) {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
    if (Number.isFinite(ms)) return Math.max(0, Math.min(RETRY_AFTER_CAP_MS, ms));
  }
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!;
}

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
