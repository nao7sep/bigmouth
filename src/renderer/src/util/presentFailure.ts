/**
 * Log the complete diagnostic while returning stable, authored display copy —
 * a catalogue message, rendered in whatever language is current when shown.
 */
export function presentFailure<T>(
  userMessage: T,
  logMessage: string,
  err: unknown,
  detail?: Record<string, unknown>,
): T {
  const diagnostic = { ...(detail ?? {}), ...describeError(err) };
  try {
    const writeRendererLog = window.bigmouth?.writeRendererLog;
    if (typeof writeRendererLog !== "function") {
      console.error("[BigMouth] Renderer diagnostic bridge is unavailable.", { logMessage, diagnostic });
      return userMessage;
    }
    writeRendererLog({
      level: "error",
      message: logMessage,
      detail: diagnostic,
    });
  } catch (reportError) {
    console.error("[BigMouth] Renderer diagnostic could not be recorded.", { reportError, logMessage, diagnostic });
  }
  return userMessage;
}

function describeError(err: unknown, seen = new WeakSet<object>()): Record<string, unknown> {
  if (err instanceof Error) {
    if (seen.has(err)) return { error: { name: err.name, message: err.message, cause: "circular" } };
    seen.add(err);
    return {
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
        ...(err.cause === undefined ? {} : { cause: describeError(err.cause, seen).error }),
      },
    };
  }
  return { error: String(err) };
}
