// A workspace's time zone for showing times: System, which follows the
// computer's zone on every launch, or one IANA zone chosen from the list
// (timestamp-conventions, Time zones). It only changes how stored UTC instants
// are shown, so System is the default and never records the zone it found.

/** The stored value for System. No IANA zone is named "system". */
export const SYSTEM_TIME_ZONE = "system";

/** Whether the runtime accepts a string as an IANA time zone. */
export function isValidTimeZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A stored preference as the app uses it: System, or a zone the runtime can
 * resolve. Anything else — missing, empty, hand-edited, or a zone this runtime
 * no longer knows — follows the computer, like an unknown theme follows the OS.
 */
export function normalizeTimeZonePreference(value: unknown): string {
  if (typeof value !== "string" || value === SYSTEM_TIME_ZONE) return SYSTEM_TIME_ZONE;
  return isValidTimeZone(value) ? value : SYSTEM_TIME_ZONE;
}

/** The computer's zone, which System follows; UTC when the platform cannot say. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The zone times are shown in for a stored preference. */
export function effectiveTimeZone(preference: string): string {
  const normalized = normalizeTimeZonePreference(preference);
  return normalized === SYSTEM_TIME_ZONE ? systemTimeZone() : normalized;
}

/**
 * The zones the Settings list offers after System: every IANA zone the
 * platform knows, plus UTC and the saved zone when the platform's list lacks
 * them, so a stored choice always stays selectable.
 */
export function timeZoneOptions(saved: string): string[] {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.add("UTC");
  if (saved !== SYSTEM_TIME_ZONE && isValidTimeZone(saved)) zones.add(saved);
  return [...zones].sort();
}
