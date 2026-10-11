import fs from "node:fs";

/** A cheap observation of one installed file, including atomic replacements and preserved mtimes. */
export function fileVersion(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch {
    return null;
  }
}
