import { describe, expect, it } from "vitest";
import {
  assetFilenameKey,
  collidingAssetFilenames,
  isReservedAssetName,
  sanitizeAssetFilename,
} from "@shared/assetNames";

describe("asset filename rules", () => {
  it("preserves Unicode and ordinary punctuation while replacing forbidden characters", () => {
    expect(sanitizeAssetFilename("../写真 (1)?.png")).toBe("写真 (1)_.png");
    expect(sanitizeAssetFilename("folder\\café.png")).toBe("café.png");
  });

  it("normalizes equivalent Unicode spellings for comparison", () => {
    expect(assetFilenameKey("CAFÉ.png")).toBe(assetFilenameKey("cafe\u0301.png"));
  });

  it("reserves bookkeeping names without relying on filesystem case behavior", () => {
    expect(isReservedAssetName("META.JSON")).toBe(true);
    expect(isReservedAssetName("upload.TMP")).toBe(true);
    expect(isReservedAssetName("photo.png")).toBe(false);
  });

  it("escapes Windows device names even when they have multiple suffixes", () => {
    expect(sanitizeAssetFilename("CON.backup.txt")).toBe("_CON.backup.txt");
  });

  it("finds distinct names that collide after sanitizing", () => {
    expect(collidingAssetFilenames(["draft?.png", "draft*.png", "other.png"])).toEqual([
      "draft_.png",
    ]);
    expect(collidingAssetFilenames(["same.png", "same.png"])).toEqual(["same.png"]);
  });
});
