/**
 * Asset routes:
 *   GET    /api/assets/:postId              — list assets for a post
 *   POST   /api/assets/:postId              — upload a new asset
 *   DELETE /api/assets/:postId/:filename    — delete an asset
 *
 * Static serving of asset files is handled separately in index.ts via
 * express.static mounted at /assets.
 */

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import exifr from "exifr";
import { imageSize } from "image-size";
import { utcNow, formatForFrontMatter } from "../shared/timestamps.js";
import { getSettings } from "../services/configStore.js";
import {
  listAssets,
  addAsset,
  deleteAsset,
  assetDir,
  assetFilePath,
  sanitizeFilename,
} from "../services/assetStore.js";

export const assetsRouter = Router();

// --- GET /api/assets/:postId ---

assetsRouter.get("/:postId", (req, res) => {
  const postId = String(req.params.postId);
  res.json(listAssets(postId));
});

// --- POST /api/assets/:postId ---

assetsRouter.post("/:postId", (req, res, next) => {
  const limitMb = getSettings().maxUploadMb ?? 500;
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limitMb * 1024 * 1024 },
  }).single("file")(req, res, next);
}, async (req, res) => {
  const postId = String(req.params.postId);

  if (!req.file) {
    res.status(400).json({ error: "No file provided" });
    return;
  }

  const filename = sanitizeFilename(req.file.originalname);
  const destPath = assetFilePath(postId, filename);

  // Write file to disk
  fs.writeFileSync(destPath, req.file.buffer);

  // Get image dimensions from actual image headers (not EXIF)
  let width: number | undefined;
  let height: number | undefined;
  let hasMetadata: boolean | undefined;

  const fileExt = path.extname(filename).slice(1).toLowerCase();
  const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);

  if (IMAGE_EXTS.has(fileExt)) {
    try {
      const dims = imageSize(req.file.buffer);
      width = dims.width;
      height = dims.height;
    } catch {
      // Dimensions unavailable
    }

    try {
      // Parse all default segments — any non-null result means metadata is present
      const exif = await exifr.parse(req.file.buffer);
      if (exif && Object.keys(exif).length > 0) hasMetadata = true;
    } catch {
      // Not an image format exifr recognises — no metadata
    }
  }

  const meta = {
    filename,
    size: req.file.buffer.length,
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(hasMetadata && { hasMetadata }),
    uploadedAt: formatForFrontMatter(utcNow()),
  };

  addAsset(postId, meta);
  res.status(201).json(meta);
});

// --- DELETE /api/assets/:postId/:filename ---

assetsRouter.delete("/:postId/:filename", (req, res) => {
  const postId = String(req.params.postId);
  const filename = String(req.params.filename);

  const filePath = path.join(assetDir(postId), filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  deleteAsset(postId, filename);
  res.status(204).send();
});
