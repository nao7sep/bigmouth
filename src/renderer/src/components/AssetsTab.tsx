import { useCallback, useEffect, useRef, useState } from "react";
import { listAssets, uploadAsset, deleteAsset, assetUrl } from "../api";
import type { AssetMeta } from "@shared/types";
import { useConfirm } from "./ConfirmHost";

interface AssetsTabProps {
  workspaceId: string;
  postId: string;
  onInsertAtCursor: (text: string) => void;
  maxUploadMb: number;
  readOnly?: boolean;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);

function ext(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function isImage(filename: string): boolean {
  return IMAGE_EXTS.has(ext(filename));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Mirrors the main-process sanitizeFilename logic
function sanitizeFilename(raw: string): string {
  const base = raw.split("/").pop() ?? raw;
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function AssetsTab({
  workspaceId,
  postId,
  onInsertAtCursor,
  maxUploadMb,
  readOnly = false,
}: AssetsTabProps) {
  const [assets, setAssets] = useState<AssetMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    try {
      const list = await listAssets(postId, workspaceId);
      setAssets(list);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to load assets");
    }
  }, [postId, workspaceId]);

  useEffect(() => {
    setAssets([]);
    setUploadError(null);
    load();
  }, [load]);

  const uploadFiles = async (files: File[]) => {
    if (readOnly) return;
    setUploading(true);
    setUploadError(null);
    const failures: string[] = [];
    for (const file of files) {
      try {
        await uploadAsset(postId, file, workspaceId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        failures.push(`${file.name}: ${message}`);
      }
    }
    await load();
    if (failures.length > 0) {
      setUploadError(`Failed to upload ${failures.length} file(s): ${failures.join("; ")}`);
    }
    setUploading(false);
  };

  const checkAndUpload = async (files: FileList | File[]) => {
    if (readOnly) return;
    const fileArray = Array.from(files);
    const limitBytes = maxUploadMb * 1024 * 1024;

    const tooLarge = fileArray.filter((f) => f.size > limitBytes);
    const uploadable = fileArray.filter((f) => f.size <= limitBytes);

    if (tooLarge.length > 0) {
      setUploadError(
        `Too large (max ${maxUploadMb} MB): ${tooLarge.map((f) => f.name).join(", ")}`
      );
    }

    if (uploadable.length === 0) return;

    const existingNames = new Set(assets.map((a) => a.filename));
    const dupes = uploadable
      .map((f) => sanitizeFilename(f.name))
      .filter((name) => existingNames.has(name));

    if (dupes.length > 0) {
      const ok = await confirm({
        title: "Replace existing file?",
        message: `${dupes.join(", ")} already exist${dupes.length === 1 ? "s" : ""}. Replace?`,
        confirmLabel: "Replace",
      });
      if (!ok) return;
    }
    await uploadFiles(uploadable);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      await checkAndUpload(e.dataTransfer.files);
    }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await checkAndUpload(e.target.files);
      e.target.value = "";
    }
  };

  const handleDelete = async (filename: string) => {
    if (readOnly) return;
    const ok = await confirm({
      message: `Delete "${filename}"?`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteAsset(postId, filename, workspaceId);
      setAssets((prev) => prev.filter((a) => a.filename !== filename));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleInsert = (filename: string) => {
    if (readOnly) return;
    const md = isImage(filename)
      ? `![${filename}](${filename})`
      : `[${filename}](${filename})`;
    onInsertAtCursor(md);
  };

  return (
    <div className="assets-tab">
      {/* Drop zone */}
      <div
        className={`assets-dropzone${dragOver ? " drag-over" : ""}`}
        onDragOver={(e) => {
          if (readOnly) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (readOnly) return;
          fileInputRef.current?.click();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileInput}
        />
        {readOnly
          ? "Assets are read-only."
          : uploading
            ? "Uploading…"
            : "Drop files here or click to upload"}
      </div>

      {uploadError && (
        <div className="assets-error">
          <span>{uploadError}</span>
          <button className="assets-error-dismiss" onClick={() => setUploadError(null)}>&times;</button>
        </div>
      )}

      {/* Asset grid */}
      {assets.length === 0 ? (
        <div className="assets-empty">No assets yet</div>
      ) : (
          <div className="assets-grid">
            {assets.map((asset) => (
              <AssetCard
                key={asset.filename}
                workspaceId={workspaceId}
                postId={postId}
                asset={asset}
                onInsert={() => handleInsert(asset.filename)}
                onDelete={() => void handleDelete(asset.filename)}
                readOnly={readOnly}
              />
            ))}
        </div>
      )}
    </div>
  );
}

// --- AssetCard sub-component ---

function AssetCard({
  workspaceId,
  postId,
  asset,
  onInsert,
  onDelete,
  readOnly,
}: {
  workspaceId: string;
  postId: string;
  asset: AssetMeta;
  onInsert: () => void;
  onDelete: () => void;
  readOnly: boolean;
}) {
  const src = assetUrl(postId, asset.filename, workspaceId);
  const img = isImage(asset.filename);

  return (
    <div className={`asset-card${asset.hasMetadata ? " has-exif" : ""}`}>
      <div className="asset-thumb">
        {img ? (
          <img src={src} alt={asset.filename} />
        ) : (
          <div className="asset-file-icon">{ext(asset.filename).toUpperCase()}</div>
        )}
      </div>
      <div className="asset-info">
        <div className="asset-name" title={asset.filename}>
          {asset.filename}
        </div>
        <div className="asset-meta">
          {formatBytes(asset.size)}
          {asset.width && asset.height && (
            <> &middot; {asset.width}&times;{asset.height}</>
          )}
        </div>
        {asset.hasMetadata && (
          <div className="asset-meta-note">Has metadata</div>
        )}
      </div>
      <div className="asset-actions">
        <button className="asset-btn" onClick={onInsert} title="Insert at cursor" disabled={readOnly}>
          Insert
        </button>
        <button className="asset-btn asset-btn-delete" onClick={onDelete} title="Delete" disabled={readOnly}>
          Delete
        </button>
      </div>
    </div>
  );
}
