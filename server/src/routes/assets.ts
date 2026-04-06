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
import { utcNow, formatForFrontMatter } from "../shared/timestamps.js";
import {
  listAssets,
  addAsset,
  deleteAsset,
  assetDir,
  assetFilePath,
  sanitizeFilename,
} from "../services/assetStore.js";

export const assetsRouter = Router();

// Store uploads in memory so we can read EXIF before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
});

// --- GET /api/assets/:postId ---

assetsRouter.get("/:postId", (req, res) => {
  const postId = String(req.params.postId);
  res.json(listAssets(postId));
});

// --- POST /api/assets/:postId ---

assetsRouter.post("/:postId", upload.single("file"), async (req, res) => {
  const postId = String(req.params.postId);

  if (!req.file) {
    res.status(400).json({ error: "No file provided" });
    return;
  }

  const filename = sanitizeFilename(req.file.originalname);
  const destPath = assetFilePath(postId, filename);

  // Write file to disk
  fs.writeFileSync(destPath, req.file.buffer);

  // Attempt EXIF extraction for images
  let width: number | undefined;
  let height: number | undefined;
  let takenAt: string | undefined;

  try {
    const exif = await exifr.parse(req.file.buffer, {
      pick: ["DateTimeOriginal", "ImageWidth", "ImageHeight", "ExifImageWidth", "ExifImageHeight"],
    });
    if (exif) {
      width = exif.ExifImageWidth ?? exif.ImageWidth;
      height = exif.ExifImageHeight ?? exif.ImageHeight;
      if (exif.DateTimeOriginal instanceof Date) {
        takenAt = exif.DateTimeOriginal.toISOString();
      }
    }
  } catch {
    // EXIF not available for this file type — skip
  }

  const meta = {
    filename,
    size: req.file.buffer.length,
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
    ...(takenAt !== undefined && { takenAt }),
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
