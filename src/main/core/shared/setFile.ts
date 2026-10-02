import fs from "node:fs";
import { writeManagedText } from "./atomicWrite.js";

/** Writes a settings file per config-sets-conventions; identical content is not rewritten. */
export function writeSetFile(filePath: string, sets: Record<string, unknown>): void {
  const text = JSON.stringify(sets, null, 2) + "\n";
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing === text || (existing === null && Object.keys(sets).length === 0)) return;
  writeManagedText(filePath, text);
}
