import { useCallback, useEffect, useRef, useState } from "react";
import { listAssets, uploadAsset, deleteAsset, assetUrl } from "../api";
import {
  collidingAssetFilenames,
  isImageAssetFilename,
  sanitizeAssetFilename,
} from "@shared/assetNames";
import type { AssetMeta } from "@shared/types";
import { useConfirm } from "./ConfirmHost";
import { XIcon } from "./Icon";

interface AssetsTabProps {
  workspaceId: string;
  postId: string;
  onInsertAtCursor: (text: string) => void;
  maxUploadMb: number;
  readOnly?: boolean;
}

const DRAG_SIGNAL_TIMEOUT_MS = 500;

type DragState = "idle" | "accepting" | "rejecting";

function offersFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

function exposesFiles(dataTransfer: DataTransfer): boolean {
  return offersFiles(dataTransfer) && dataTransfer.files.length > 0;
}

function ext(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function isImage(filename: string): boolean {
  return isImageAssetFilename(filename);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function markdownLabel(filename: string): string {
  return filename.replace(/([\\\[\]])/g, "\\$1");
}

function markdownDestination(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
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
  const [dragState, setDragState] = useState<DragState>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragSignalTimeoutRef = useRef<number | undefined>(undefined);
  const confirm = useConfirm();

  const resetDragState = useCallback(() => {
    if (dragSignalTimeoutRef.current !== undefined) {
      window.clearTimeout(dragSignalTimeoutRef.current);
      dragSignalTimeoutRef.current = undefined;
    }
    setDragState("idle");
  }, []);

  const pulseDragState = useCallback((state: Exclude<DragState, "idle">) => {
    if (dragSignalTimeoutRef.current !== undefined) {
      window.clearTimeout(dragSignalTimeoutRef.current);
    }
    setDragState(state);
    dragSignalTimeoutRef.current = window.setTimeout(() => {
      dragSignalTimeoutRef.current = undefined;
      setDragState("idle");
    }, DRAG_SIGNAL_TIMEOUT_MS);
  }, []);

  useEffect(
    () => () => {
      if (dragSignalTimeoutRef.current !== undefined) {
        window.clearTimeout(dragSignalTimeoutRef.current);
      }
    },
    [],
  );

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

    const batchCollisions = collidingAssetFilenames(uploadable.map((file) => file.name));
    if (batchCollisions.length > 0) {
      setUploadError(
        `Some selected files resolve to the same asset name (${batchCollisions.join(", ")}). ` +
          "Rename them before uploading so none are overwritten.",
      );
      return;
    }

    const existingNames = new Set(assets.map((a) => a.filename.normalize("NFC")));
    const dupes = uploadable
      .map((f) => sanitizeAssetFilename(f.name))
      .filter((name) => existingNames.has(name.normalize("NFC")));

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
    resetDragState();
    // Always neutralize the webview's native text/URL/file drop behavior before
    // deciding whether this drop belongs to the asset importer.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "none";
    if (readOnly || e.dataTransfer.files.length === 0) return;
    e.dataTransfer.dropEffect = "copy";
    await checkAndUpload(e.dataTransfer.files);
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
    const label = markdownLabel(filename);
    const destination = markdownDestination(filename);
    const md = isImage(filename)
      ? `![${label}](${destination})`
      : `[${label}](${destination})`;
    onInsertAtCursor(md);
  };

  return (
    <div className="assets-tab">
      {/* Drop zone */}
      <div
        className={
          `assets-dropzone${dragState === "accepting" ? " drag-over" : ""}` +
          `${dragState === "rejecting" ? " drag-rejected" : ""}`
        }
        aria-disabled={readOnly || undefined}
        onDragOver={(e) => {
          // Finder may advertise only the protected `Files` type during
          // dragover. Prevent the browser default so the eventual drop can be
          // inspected, but do not advertise acceptance until File objects are
          // actually available.
          e.preventDefault();
          e.stopPropagation();
          if (readOnly || !offersFiles(e.dataTransfer)) {
            e.dataTransfer.dropEffect = "none";
            pulseDragState("rejecting");
            return;
          }
          if (!exposesFiles(e.dataTransfer)) {
            e.dataTransfer.dropEffect = "none";
            resetDragState();
            return;
          }
          e.dataTransfer.dropEffect = "copy";
          pulseDragState("accepting");
        }}
        onDragLeave={resetDragState}
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
          <button className="assets-error-dismiss" onClick={() => setUploadError(null)}><XIcon /></button>
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
