/** Creates the data directory tree without saving untouched settings. */
import { createDirectory } from "../shared/publication.js";
import path from "node:path";

export function initializeWorkspaceData(dataDir: string): void {
  for (const sub of ["posts", "assets"]) {
    createDirectory(path.join(dataDir, sub));
  }
}
