import { fileHeader } from "@main/core/shared/storeFormat.js";
import type { StoreFormat } from "@main/core/shared/formatVersions.js";

export { fileHeader };

/** The header a newer build would write for `format` at `version`. */
export function newerHeader(format: StoreFormat, version: number): ReturnType<typeof fileHeader> {
  const header = fileHeader(format);
  return { ...header, format: { ...header.format, version } };
}

/** A post's header as YAML front matter lines, for posts written by hand in a test. */
export const POST_HEADER_YAML = "format:\n  owner: bigmouth\n  kind: post\n  version: 1\n";
