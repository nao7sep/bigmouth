import { isImageAssetFilename } from "@shared/assetNames";
import type { AssetMeta } from "@shared/types";

/**
 * How an attached file is pictured.
 *
 * A still image is shown through the smaller renditions main makes of it, a
 * thumbnail on its card and a display image in the Preview, so no surface
 * decodes a large photo at full size. An animated image is shown as itself,
 * since a rendition would stop it, and any other file by its file-type tile.
 */
export type AssetPicture =
  | { kind: "derived"; contentHash: string }
  | { kind: "original" }
  | { kind: "file" };

// Formats that can hold an animation sharp reads as one.
const ANIMATABLE_EXTENSIONS = new Set(["gif", "webp"]);

function extension(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

export function assetPicture(asset: Pick<AssetMeta, "filename" | "animated" | "contentHash">): AssetPicture {
  if (!isImageAssetFilename(asset.filename)) return { kind: "file" };
  if (asset.animated === true) return { kind: "original" };
  // An image added before its frames were recorded may move; one in a format
  // that can is shown as itself, as it was before renditions existed.
  if (asset.animated === undefined && ANIMATABLE_EXTENSIONS.has(extension(asset.filename))) return { kind: "original" };
  // No hash: its file could not be read when it was listed. The original's
  // request fails the same way, and the card falls back to the file tile.
  if (!asset.contentHash) return { kind: "original" };
  return { kind: "derived", contentHash: asset.contentHash };
}

