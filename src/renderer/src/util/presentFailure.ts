/** Log the complete diagnostic while returning stable, authored display copy. */
export function presentFailure(
  userMessage: string,
  logMessage: string,
  err: unknown,
  detail?: Record<string, unknown>,
): string {
  try {
    window.bigmouth?.writeRendererLog({
      level: "error",
      message: logMessage,
      detail: { ...(detail ?? {}), ...describeError(err) },
    });
  } catch {
    // Reporting must not replace a recovered operation failure.
  }
  return userMessage;
}

function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { error: { name: err.name, message: err.message, stack: err.stack } };
  }
  return { error: String(err) };
}
