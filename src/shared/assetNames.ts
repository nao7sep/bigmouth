// Characters no filename may carry: C0/C7F controls, and the set Windows
// forbids outright. Everything else is kept so names in every script survive.
const FORBIDDEN_IN_FILENAME = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

const WINDOWS_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** A portable comparison key for filenames on case-insensitive Unicode filesystems. */
export function assetFilenameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Sanitizes an uploaded filename into one storable on every supported platform.
 * This module is shared so the renderer's replacement prompt and the main
 * process always make the same filename decision.
 */
export function sanitizeAssetFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const cleaned = base.normalize("NFC").replace(FORBIDDEN_IN_FILENAME, "_");
  const trimmed = cleaned.replace(/[. ]+$/, "");
  if (trimmed === "") return "asset";

  // Windows reserves a device stem before any extension, including names with
  // more than one suffix such as CON.backup.txt.
  const stem = trimmed.split(".", 1)[0];
  return WINDOWS_DEVICE_NAMES.has(stem.toLowerCase()) ? `_${trimmed}` : trimmed;
}

/** Names reserved for the asset metadata cache and temporary/hidden files. */
export function isReservedAssetName(name: string): boolean {
  const key = assetFilenameKey(name);
  return key === "meta.json" || name.startsWith(".") || key.endsWith(".tmp");
}
