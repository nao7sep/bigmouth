import { isMessage, type Message } from "./translate.js";

// Electron hands the renderer only a rejected handler's error message, so a
// failure the user is told about in its own words carries its message as text
// at the end of the error's message, after this marker.
const MARKER = "bigmouth-message:";

/** The error message that carries `carried` to the renderer. */
export function carryingText(carried: Message): string {
  return MARKER + JSON.stringify(carried);
}

/** The message an error carries, or null when it carries none. */
export function carriedMessage(err: unknown): Message | null {
  if (!(err instanceof Error)) return null;
  const at = err.message.indexOf(MARKER);
  if (at === -1) return null;
  try {
    const parsed: unknown = JSON.parse(err.message.slice(at + MARKER.length));
    return isMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
