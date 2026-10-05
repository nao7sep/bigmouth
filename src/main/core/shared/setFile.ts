import fs from "node:fs";
import { writeManagedText } from "./atomicWrite.js";
import { jsonStoreText } from "./storeFormat.js";
import type { StoreFormat } from "./formatVersions.js";

/** Writes a settings file per config-sets-conventions; identical content is not rewritten. */
export function writeSetFile(format: StoreFormat, filePath: string, sets: Record<string, unknown>): void {
  const text = jsonStoreText(format, sets);
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing === text || (existing === null && Object.keys(sets).length === 0)) return;
  writeManagedText(filePath, text);
}
