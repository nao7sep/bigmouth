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
  safeResolveUnder,
} from "../services/assetStore.js";

export const assetsRouter = Router({ mergeParams: true });

// --- Identifier validation (defense against path traversal) ---
//
// postId is a nanoid → must match the nanoid alphabet exactly.
// filename is a single path component → must not contain separators or `..`.

const POST_ID_RE = /^[A-Za-z0-9_-]+$/;

function readPostId(raw: unknown): string | null {
  const id = String(raw);
  return POST_ID_RE.test(id) ? id : null;
}

function readFilename(raw: unknown): string | null {
  const name = String(raw);
  if (!name) return null;
  if (name === "." || name === "..") return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  // Defensive: filename should not differ from its basename.
  if (path.basename(name) !== name) return null;
  return name;
}

// --- GET /api/w/:wsId/assets/:postId ---

assetsRouter.get("/:postId", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const postId = readPostId(req.params.postId);
  if (!postId) {
    res.status(400).json({ error: "Invalid postId" });
    return;
  }
  res.json(listAssets(dataDir, postId));
});

// --- GET /api/w/:wsId/assets/:postId/:filename/raw ---

assetsRouter.get("/:postId/:filename/raw", (req, res) => {
  const dataDir = res.locals.dataDir as string;
  const postId = readPostId(req.params.postId);
  const filename = readFilename(req.params.filename);
  if (!postId || !filename) {
    res.status(400).json({ error: "Invalid postId or filename" });
    return;
  }

  let filePath: string;
  try {
    filePath = safeResolveUnder(assetDir(dataDir, postId), filename);
  } catch {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

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
  const postId = readPostId(req.params.postId);
  if (!postId) {
    res.status(400).json({ error: "Invalid postId" });
    return;
  }

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
  const postId = readPostId(req.params.postId);
  const filename = readFilename(req.params.filename);
  if (!postId || !filename) {
    res.status(400).json({ error: "Invalid postId or filename" });
    return;
  }

  let filePath: string;
  try {
    filePath = safeResolveUnder(assetDir(dataDir, postId), filename);
  } catch {
    res.status(400).json({ error: "Invalid path" });
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }

  deleteAsset(dataDir, postId, filename);
  res.status(204).send();
});
