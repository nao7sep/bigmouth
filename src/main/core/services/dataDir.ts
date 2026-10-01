/** Creates the data directory tree without saving untouched settings. */
import fs from "node:fs";
import path from "node:path";

export function initializeWorkspaceData(dataDir: string): void {
  for (const sub of ["posts", "assets"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}
