/**
 * Asset routes:
 *   GET    /api/w/:wsId/assets/:postId              — list assets for a post
 *   POST   /api/w/:wsId/assets/:postId              — upload a new asset
 *   DELETE /api/w/:wsId/assets/:postId/:filename    — delete an asset
 *   GET    /api/w/:wsId/assets/:postId/:filename/raw — serve the raw file
 */

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import exifr from "exifr";
import { imageSize } from "image-size";
import { utcNow, formatForFrontMatter } from "../shared/timestamps.js";
import { getSettings } from "../services/configStore.js";
import { error as logError } from "../services/logger.js";
import {
  listAssets,
  addAsset,
  deleteAsset,
  assetDir,
  assetFilePath,
  sanitizeFilename,
} from "../services/assetStore.js";

export const assetsRouter = Router({ mergeParams: true });

// --- GET /api/w/:wsId/assets/:postId ---

assetsRouter.get("/:postId", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const postId = String(req.params.postId);
  res.json(listAssets(dataDir, postId));
});

// --- GET /api/w/:wsId/assets/:postId/:filename/raw ---

assetsRouter.get("/:postId/:filename/raw", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const postId = String(req.params.postId);
  const filename = String(req.params.filename);
  const filePath = path.join(assetDir(dataDir, postId), filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  res.type(filename);
  const stream = fs.createReadStream(filePath);
  stream.on("error", (err) => {
    logError(
      `Failed to read asset "${filename}" for post "${postId}" at "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read asset" });
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
});

// --- POST /api/w/:wsId/assets/:postId ---

assetsRouter.post("/:postId", (req, res, next) => {
  const dataDir = res.locals.dataDir as string;
  const limitMb = getSettings(dataDir).maxUploadMb ?? 500;
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limitMb * 1024 * 1024 },
  }).single("file")(req, res, next);
}, async (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const postId = String(req.params.postId);

  if (!req.file) {
    res.status(400).json({ error: "No file provided" });
    return;
  }

  const filename = sanitizeFilename(req.file.originalname);
  const destPath = assetFilePath(dataDir, postId, filename);

  fs.writeFileSync(destPath, req.file.buffer);

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
      const exif = await exifr.parse(req.file.buffer);
      if (exif && Object.keys(exif).length > 0) hasMetadata = true;
    } catch {
      // Not an image format exifr recognises
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

  addAsset(dataDir, postId, meta);
  res.status(201).json(meta);
});

// --- DELETE /api/w/:wsId/assets/:postId/:filename ---

assetsRouter.delete("/:postId/:filename", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const postId = String(req.params.postId);
  const filename = String(req.params.filename);

  const filePath = path.join(assetDir(dataDir, postId), filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  deleteAsset(dataDir, postId, filename);
  res.status(204).send();
});
