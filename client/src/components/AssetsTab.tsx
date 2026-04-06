import { useCallback, useEffect, useRef, useState } from "react";
import { fetchAssets, uploadAsset, deleteAsset } from "../api";
import type { AssetMeta } from "../types";
import { ConfirmModal } from "./ConfirmModal";

interface AssetsTabProps {
  postId: string;
  onInsertAtCursor: (text: string) => void;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg"]);

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

export function AssetsTab({ postId, onInsertAtCursor }: AssetsTabProps) {
  const [assets, setAssets] = useState<AssetMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await fetchAssets(postId);
      setAssets(list);
    } catch {
      // Failed to load — leave list empty
    }
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  const uploadFiles = async (files: FileList | File[]) => {
    setUploading(true);
    for (const file of Array.from(files)) {
      try {
        await uploadAsset(postId, file);
      } catch {
        // Skip failed uploads
      }
    }
    await load();
    setUploading(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      await uploadFiles(e.dataTransfer.files);
    }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await uploadFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handleDelete = async (filename: string) => {
    setDeleteTarget(null);
    try {
      await deleteAsset(postId, filename);
      setAssets((prev) => prev.filter((a) => a.filename !== filename));
    } catch {
      // Delete failed
    }
  };

  const handleInsert = (filename: string) => {
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
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileInput}
        />
        {uploading
          ? "Uploading…"
          : "Drop files here or click to upload"}
      </div>

      {/* Asset grid */}
      {assets.length === 0 ? (
        <div className="assets-empty">No assets yet</div>
      ) : (
        <div className="assets-grid">
          {assets.map((asset) => (
            <AssetCard
              key={asset.filename}
              postId={postId}
              asset={asset}
              onInsert={() => handleInsert(asset.filename)}
              onDelete={() => setDeleteTarget(asset.filename)}
            />
          ))}
        </div>
      )}
      {deleteTarget && (
        <ConfirmModal
          message={`Delete "${deleteTarget}"?`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// --- AssetCard sub-component ---

function AssetCard({
  postId,
  asset,
  onInsert,
  onDelete,
}: {
  postId: string;
  asset: AssetMeta;
  onInsert: () => void;
  onDelete: () => void;
}) {
  const src = `/assets/${postId}/${encodeURIComponent(asset.filename)}`;
  const img = isImage(asset.filename);

  return (
    <div className={`asset-card${asset.hasMetadata ? " has-exif" : ""}`}>
      <div className="asset-thumb">
        {img ? (
          <img src={src} alt={asset.filename} />
        ) : (
          <div className="asset-file-icon">{ext(asset.filename).toUpperCase()}</div>
        )}
        {asset.hasMetadata && (
          <div className="asset-exif-badge" title="Image contains EXIF/IPTC/XMP metadata — sanitize before publishing">
            ⚠ Metadata
          </div>
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
      </div>
      <div className="asset-actions">
        <button className="asset-btn" onClick={onInsert} title="Insert at cursor">
          Insert
        </button>
        <button className="asset-btn asset-btn-delete" onClick={onDelete} title="Delete">
          Delete
        </button>
      </div>
    </div>
  );
}
