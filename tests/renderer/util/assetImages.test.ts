import { describe, expect, it } from "vitest";
import { assetPicture } from "@renderer/util/assetImages";

const hash = "f".repeat(64);

describe("assetPicture", () => {
  it("shows a still image through its renditions, by its hash", () => {
    expect(assetPicture({ filename: "photo.JPG", animated: false, contentHash: hash })).toEqual({ kind: "derived", contentHash: hash });
    // Recorded before frames were, in a format that cannot animate.
    expect(assetPicture({ filename: "photo.png", contentHash: hash })).toEqual({ kind: "derived", contentHash: hash });
  });

  it("shows an animated image, or one that may be, as itself", () => {
    expect(assetPicture({ filename: "moving.png", animated: true, contentHash: hash })).toEqual({ kind: "original" });
    expect(assetPicture({ filename: "older.gif", contentHash: hash })).toEqual({ kind: "original" });
    expect(assetPicture({ filename: "older.webp", contentHash: hash })).toEqual({ kind: "original" });
    expect(assetPicture({ filename: "still.webp", animated: false, contentHash: hash })).toEqual({ kind: "derived", contentHash: hash });
  });

  it("shows an image without a hash as itself, whose failure shows the tile", () => {
    expect(assetPicture({ filename: "unread.jpg", animated: false })).toEqual({ kind: "original" });
  });

  it("shows any other file by its tile", () => {
    expect(assetPicture({ filename: "notes.pdf", contentHash: hash })).toEqual({ kind: "file" });
    expect(assetPicture({ filename: "drawing.svg", contentHash: hash })).toEqual({ kind: "file" });
  });
});
