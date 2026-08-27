import { isReservedAssetName, sanitizeAssetFilename } from "@shared/assetNames";

export type AssetDragOffer = "rejected" | "delivery-only" | "accepted";

function inspectFiles(files: File[], maxBytes: number): AssetDragOffer {
  let accepted = 0;
  let rejected = 0;
  for (const file of files) {
    if (
      file.size <= maxBytes &&
      !isReservedAssetName(sanitizeAssetFilename(file.name))
    ) accepted += 1;
    else rejected += 1;
  }
  if (accepted > 0 && rejected > 0) return "delivery-only";
  return accepted > 0 ? "accepted" : "rejected";
}

/** Classify only what Chromium exposes while hovering. Native Finder offers
 * can hide their files until drop, so that state remains delivery-only. */
export function inspectAssetDragOffer(
  dataTransfer: Pick<DataTransfer, "types" | "items" | "files">,
  maxBytes = Number.POSITIVE_INFINITY,
): AssetDragOffer {
  const items = Array.from(dataTransfer.items ?? []);
  if (!Array.from(dataTransfer.types).includes("Files") && !items.some((item) => item.kind === "file")) {
    return "rejected";
  }
  const files = Array.from(dataTransfer.files ?? []);
  if (files.length > 0) {
    return inspectFiles(files, maxBytes);
  }
  if (items.length === 0) return "delivery-only";

  let protectedFile = false;
  const exposedFiles: File[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    try {
      const file = item.getAsFile();
      if (file) exposedFiles.push(file);
      else protectedFile = true;
    } catch {
      protectedFile = true;
    }
  }
  if (protectedFile) return "delivery-only";
  return exposedFiles.length > 0 ? inspectFiles(exposedFiles, maxBytes) : "rejected";
}
