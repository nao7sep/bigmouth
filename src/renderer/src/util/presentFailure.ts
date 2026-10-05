import type { Message } from "@shared/i18n/translate";
import { carriedMessage } from "@shared/i18n/carriedMessage";

/**
 * Log the complete diagnostic while returning stable, authored display copy —
 * a catalogue message, rendered in whatever language is current when shown.
 * A failure that carries its own message (a store a newer version of BigMouth
 * wrote, named with its path) is shown in those words instead.
 */
export function presentFailure(
  userMessage: Message,
  logMessage: string,
  err: unknown,
  detail?: Record<string, unknown>,
): Message {
  const shown = carriedMessage(err) ?? userMessage;
  const diagnostic = { ...(detail ?? {}), ...describeError(err) };
  try {
    const writeRendererLog = window.bigmouth?.writeRendererLog;
    if (typeof writeRendererLog !== "function") {
      console.error("[BigMouth] Renderer diagnostic bridge is unavailable.", { logMessage, diagnostic });
      return shown;
    }
    writeRendererLog({
      level: "error",
      message: logMessage,
      detail: diagnostic,
    });
  } catch (reportError) {
    console.error("[BigMouth] Renderer diagnostic could not be recorded.", { reportError, logMessage, diagnostic });
  }
  return shown;
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
