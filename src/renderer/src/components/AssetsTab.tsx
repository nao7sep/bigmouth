import { useCallback, useEffect, useRef, useState } from "react";
import { listAssets, uploadAsset, deleteAsset, assetUrl, reportProblem } from "../api";
import {
  collidingAssetFilenames,
  isImageAssetFilename,
  isReservedAssetName,
  sanitizeAssetFilename,
} from "@shared/assetNames";
import type { AssetMeta } from "@shared/types";
import { useConfirm } from "./ConfirmHost";
import { OperationalResult } from "./OperationalResult";
import { inspectAssetDragOffer } from "../util/assetDrop";
import { AssetUploadAdmissionError } from "../util/assetUpload";

interface AssetsTabProps {
  workspaceId: string;
  postId: string;
  onInsertAtCursor: (text: string) => void;
  maxUploadMb: number;
  readOnly?: boolean;
}

type DragState = "idle" | "delivery" | "accepting" | "rejecting";
type AssetNotice = {
  severity: "warning" | "error";
  message: string;
  issueKeys: string[];
};

function assetIssueKey(file: Pick<File, "name">): string {
  // Keep the offered spelling, not the stored/sanitized name: two distinct
  // inputs that collide after sanitization are two unresolved items, and one
  // later upload must not falsely clear the batch-collision result for both.
  return `asset:${file.name.normalize("NFC")}`;
}

function coversIssueKeys(resolved: readonly string[], issues: readonly string[]): boolean {
  const resolvedSet = new Set(resolved);
  const issueSet = new Set(issues);
  return issueSet.size > 0 && [...issueSet].every((key) => resolvedSet.has(key));
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
  const [uploadNotice, setUploadNotice] = useState<AssetNotice | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const assetsRef = useRef<AssetMeta[]>([]);
  const uploadTailRef = useRef<Promise<void>>(Promise.resolve());
  const queuedUploadsRef = useRef(0);
  const confirm = useConfirm();

  const resetDragState = useCallback(() => {
    setDragState("idle");
  }, []);

  const load = useCallback(async (): Promise<string | null> => {
    try {
      const list = await listAssets(postId, workspaceId);
      assetsRef.current = list;
      setAssets(list);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Failed to load assets";
    }
  }, [postId, workspaceId]);

  useEffect(() => {
    setAssets([]);
    assetsRef.current = [];
    setUploadNotice(null);
    void load().then((message) => {
      if (message) setUploadNotice({
        severity: "error",
        message,
        issueKeys: [`refresh:${postId}`],
      });
    });
  }, [load]);

  const uploadFiles = async (
    files: File[],
    rejected: Array<{ file: File; message: string }>,
    operationKeys: string[],
  ) => {
    if (readOnly) return;
    const admissionFailures: Array<{ file: File; message: string }> = [];
    const operationalFailures: Array<{ file: File; message: string }> = [];
    for (const file of files) {
      try {
        await uploadAsset(postId, file, workspaceId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        if (err instanceof AssetUploadAdmissionError) {
          admissionFailures.push({ file, message });
        } else {
          operationalFailures.push({ file, message });
          reportProblem("Asset upload failed.", err, { postId, filename: file.name });
        }
      }
    }
    const refreshFailure = await load();
    const invalid = [...rejected, ...admissionFailures];
    if (invalid.length > 0 || operationalFailures.length > 0 || refreshFailure) {
      const addedCount = files.length - admissionFailures.length - operationalFailures.length;
      const parts: string[] = [];
      if (addedCount > 0) {
        parts.push(`Added ${addedCount} asset${addedCount === 1 ? "" : "s"}`);
      }
      if (invalid.length > 0) {
        parts.push(
          `${invalid.length} item${invalid.length === 1 ? "" : "s"} could not be added: ` +
          invalid.map(({ file, message }) => `${file.name}: ${message}`).join("; "),
        );
      }
      if (operationalFailures.length > 0) {
        parts.push(
          `${operationalFailures.length} upload${operationalFailures.length === 1 ? "" : "s"} failed: ` +
          operationalFailures.map(({ file, message }) => `${file.name}: ${message}`).join("; "),
        );
      }
      if (refreshFailure) parts.push(`Asset list could not be refreshed: ${refreshFailure}`);
      setUploadNotice({
        severity: operationalFailures.length > 0 || refreshFailure ? "error" : "warning",
        message: `${parts.join("; ")}.`,
        issueKeys: [
          ...invalid.map(({ file }) => assetIssueKey(file)),
          ...operationalFailures.map(({ file }) => assetIssueKey(file)),
          ...(refreshFailure ? [`refresh:${postId}`] : []),
        ],
      });
    } else {
      setUploadNotice((current) => {
        if (current === null) return null;
        const resolvedKeys = [...operationKeys, `refresh:${postId}`];
        if (coversIssueKeys(resolvedKeys, current.issueKeys)) return null;
        return current;
      });
    }
  };

  const checkAndUpload = async (files: FileList | File[]) => {
    if (readOnly) return;
    const fileArray = Array.from(files);
    const limitBytes = maxUploadMb * 1024 * 1024;

    const tooLarge = fileArray.filter((f) => f.size > limitBytes);
    const reserved = fileArray.filter((file) =>
      file.size <= limitBytes && isReservedAssetName(sanitizeAssetFilename(file.name))
    );
    const uploadable = fileArray.filter((file) =>
      file.size <= limitBytes && !isReservedAssetName(sanitizeAssetFilename(file.name))
    );
    const rejected = [
      ...tooLarge.map((file) => ({ file, message: `is larger than ${maxUploadMb} MB` })),
      ...reserved.map((file) => ({
        file,
        message: "uses a name BigMouth keeps for its own bookkeeping; rename it and try again",
      })),
    ];
    const operationKeys = fileArray.map(assetIssueKey);

    if (uploadable.length === 0) {
      if (rejected.length > 0) {
        setUploadNotice({
          severity: "warning",
          message: `${rejected.length} item${rejected.length === 1 ? "" : "s"} could not be added: ` +
            `${rejected.map(({ file, message }) => `${file.name}: ${message}`).join("; ")}.`,
          issueKeys: rejected.map(({ file }) => assetIssueKey(file)),
        });
      }
      return;
    }

    const batchCollisions = collidingAssetFilenames(uploadable.map((file) => file.name));
    if (batchCollisions.length > 0) {
      const details = [
        `some selected files resolve to the same asset name (${batchCollisions.join(", ")}). ` +
          "Rename them before uploading so none are overwritten",
        ...rejected.map(({ file, message }) => `${file.name}: ${message}`),
      ];
      setUploadNotice({
        severity: "warning",
        message: `${fileArray.length} items could not be added: ${details.join("; ")}.`,
        issueKeys: operationKeys,
      });
      return;
    }

    const existingNames = new Set(assetsRef.current.map((a) => a.filename.normalize("NFC")));
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
    await uploadFiles(uploadable, rejected, operationKeys);
  };

  const enqueueUpload = async (files: FileList | File[]) => {
    const captured = Array.from(files);
    if (captured.length === 0) return;
    queuedUploadsRef.current += 1;
    setUploading(true);
    const operation = uploadTailRef.current.then(() => checkAndUpload(captured));
    uploadTailRef.current = operation.catch(() => undefined);
    try {
      await operation;
    } catch (err) {
      reportProblem("Asset upload transaction failed.", err, { postId });
      setUploadNotice({
        severity: "error",
        message: err instanceof Error ? err.message : "Asset upload failed.",
        issueKeys: captured.map(assetIssueKey),
      });
    } finally {
      queuedUploadsRef.current -= 1;
      if (queuedUploadsRef.current === 0) setUploading(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    resetDragState();
    // Always neutralize the webview's native text/URL/file drop behavior before
    // deciding whether this drop belongs to the asset importer.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "none";
    if (readOnly) {
      setUploadNotice({
        severity: "warning",
        message: "Assets are read-only.",
        issueKeys: ["receiver:read-only"],
      });
      return;
    }
    if (e.dataTransfer.files.length === 0) {
      setUploadNotice({
        severity: "warning",
        message: "The Assets collection accepts files from Finder or Upload.",
        issueKeys: ["offer:non-file"],
      });
      return;
    }
    e.dataTransfer.dropEffect = "copy";
    await enqueueUpload(e.dataTransfer.files);
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await enqueueUpload(e.target.files);
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
      setAssets((prev) => {
        const next = prev.filter((a) => a.filename !== filename);
        assetsRef.current = next;
        return next;
      });
    } catch (err) {
      setUploadNotice({
        severity: "error",
        message: err instanceof Error ? err.message : "Delete failed",
        issueKeys: [`delete:${filename}`],
      });
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
    <div
      className={
        `assets-tab${dragState === "accepting" ? " drag-over" : ""}` +
        `${dragState === "delivery" ? " drag-delivery" : ""}` +
        `${dragState === "rejecting" ? " drag-rejected" : ""}`
      }
      aria-disabled={readOnly || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const offer = inspectAssetDragOffer(e.dataTransfer, maxUploadMb * 1024 * 1024);
        if (readOnly || offer === "rejected") {
          e.dataTransfer.dropEffect = "none";
          setDragState("rejecting");
          return;
        }
        // Chromium needs a transport action to deliver Finder's protected
        // Files offer. The neutral state does not claim those hidden files
        // have passed the upload boundary yet.
        e.dataTransfer.dropEffect = "copy";
        setDragState(offer === "accepted" ? "accepting" : "delivery");
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        resetDragState();
      }}
      onDrop={handleDrop}
    >
      <div className="assets-toolbar">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={handleFileInput}
        />
        <button
          type="button"
          className="btn-toolbar"
          disabled={readOnly || uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>
      </div>

      {uploadNotice && (
        <OperationalResult
          severity={uploadNotice.severity}
          className={`assets-result assets-result--${uploadNotice.severity}`}
          dismissClassName="assets-result-dismiss"
          onDismiss={() => setUploadNotice(null)}
        >
          {uploadNotice.message}
        </OperationalResult>
      )}

      {/* Asset grid */}
      {assets.length === 0 ? (
        <div className="assets-empty">
          {readOnly ? "No assets yet" : "No assets yet. Drop files here or use Upload."}
        </div>
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
