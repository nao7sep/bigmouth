import { useCallback, useEffect, useRef, useState } from "react";
import type { HTMLAttributes } from "react";
import { listAssets, uploadAsset, deleteAsset, assetUrl, reportProblem } from "../api";
import { presentFailure } from "../util/presentFailure";
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
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";

interface AssetsTabProps extends Pick<
  HTMLAttributes<HTMLDivElement>,
  "aria-labelledby" | "className" | "id" | "role"
> {
  workspaceId: string;
  postId: string;
  onInsertAtCursor: (text: string) => void;
  maxUploadMb: number;
  readOnly?: boolean;
}

type DragState = "idle" | "delivery" | "accepting" | "rejecting";
// One line of a notice, with the files it is about listed under it.
type NoticeLine = { message: Message; items?: Array<{ name: string; reason: Message }> };
type AssetNotice = {
  severity: "warning" | "error";
  lines: NoticeLine[];
  issueKeys: string[];
};

function notAdded(items: Array<{ file: File; reason: Message }>, count = items.length): NoticeLine {
  return {
    message: message("assets.notAdded", { count }),
    items: items.map(({ file, reason }) => ({ name: file.name, reason })),
  };
}

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

function formatBytes(n: number, locale: string): string {
  const [value, unit] =
    n < 1024 ? [n, "byte"] : n < 1024 * 1024 ? [n / 1024, "kilobyte"] : [n / (1024 * 1024), "megabyte"];
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    minimumFractionDigits: unit === "byte" ? 0 : 1,
    maximumFractionDigits: unit === "byte" ? 0 : 1,
  }).format(value);
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
  ...containerProps
}: AssetsTabProps) {
  const { t, text, list } = useI18n();
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

  const load = useCallback(async (): Promise<Message | null> => {
    try {
      const list = await listAssets(postId, workspaceId);
      assetsRef.current = list;
      setAssets(list);
      return null;
    } catch (err) {
      return presentFailure(
        message("assets.loadFailed"),
        "renderer: asset list failed",
        err,
        { postId },
      );
    }
  }, [postId, workspaceId]);

  useEffect(() => {
    setAssets([]);
    assetsRef.current = [];
    setUploadNotice(null);
    void load().then((failure) => {
      if (failure) setUploadNotice({
        severity: "error",
        lines: [{ message: failure }],
        issueKeys: [`refresh:${postId}`],
      });
    });
  }, [load]);

  const uploadFiles = async (
    files: File[],
    rejected: Array<{ file: File; reason: Message }>,
    operationKeys: string[],
  ) => {
    if (readOnly) return;
    const admissionFailures: Array<{ file: File; reason: Message }> = [];
    const operationalFailures: Array<{ file: File; reason: Message }> = [];
    for (const file of files) {
      try {
        await uploadAsset(postId, file, workspaceId);
      } catch (err) {
        if (err instanceof AssetUploadAdmissionError) {
          admissionFailures.push({ file, reason: err.reason });
        } else {
          operationalFailures.push({ file, reason: message("assets.fileNotAdded") });
          reportProblem("Asset upload failed.", err, { postId, filename: file.name });
        }
      }
    }
    const refreshFailure = await load();
    const invalid = [...rejected, ...admissionFailures];
    if (invalid.length > 0 || operationalFailures.length > 0 || refreshFailure) {
      const addedCount = files.length - admissionFailures.length - operationalFailures.length;
      const lines: NoticeLine[] = [];
      if (addedCount > 0) lines.push({ message: message("assets.added", { count: addedCount }) });
      if (invalid.length > 0) lines.push(notAdded(invalid));
      if (operationalFailures.length > 0) lines.push(notAdded(operationalFailures));
      if (refreshFailure) lines.push({ message: refreshFailure });
      setUploadNotice({
        severity: operationalFailures.length > 0 || refreshFailure ? "error" : "warning",
        lines,
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
      ...tooLarge.map((file) => ({ file, reason: message("assets.admissionTooLarge", { max: maxUploadMb }) })),
      ...reserved.map((file) => ({ file, reason: message("assets.reservedName") })),
    ];
    const operationKeys = fileArray.map(assetIssueKey);

    if (uploadable.length === 0) {
      if (rejected.length > 0) {
        setUploadNotice({
          severity: "warning",
          lines: [notAdded(rejected)],
          issueKeys: rejected.map(({ file }) => assetIssueKey(file)),
        });
      }
      return;
    }

    const batchCollisions = collidingAssetFilenames(uploadable.map((file) => file.name));
    if (batchCollisions.length > 0) {
      setUploadNotice({
        severity: "warning",
        lines: [
          notAdded(rejected, fileArray.length),
          { message: message("assets.collision", { names: list(batchCollisions) }) },
        ],
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
        title: t("assets.replaceTitle"),
        message: t("assets.replaceMessage", { count: dupes.length, names: list(dupes) }),
        confirmLabel: t("assets.replace"),
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
        lines: [{ message: message("assets.addFailed") }],
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
        lines: [{ message: message("assets.readOnly") }],
        issueKeys: ["receiver:read-only"],
      });
      return;
    }
    if (e.dataTransfer.files.length === 0) {
      setUploadNotice({
        severity: "warning",
        lines: [{ message: message("assets.filesOnly") }],
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
      message: t("assets.deleteMessage", { name: filename }),
      confirmLabel: t("common.delete"),
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
      reportProblem("Asset deletion failed.", err, { postId, filename });
      setUploadNotice({
        severity: "error",
        lines: [{ message: message("assets.deleteFailed", { name: filename }) }],
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
      {...containerProps}
      className={
        `assets-tab${dragState === "accepting" ? " drag-over" : ""}` +
        `${dragState === "delivery" ? " drag-delivery" : ""}` +
        `${dragState === "rejecting" ? " drag-rejected" : ""}` +
        `${containerProps.className ? ` ${containerProps.className}` : ""}`
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
        <div className="assets-note">
          {readOnly ? t("assets.lockedNote") : t("assets.dropNote")}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={handleFileInput}
        />
        <button
          type="button"
          className="action-button"
          disabled={readOnly || uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? t("assets.adding") : t("assets.add")}
        </button>
      </div>

      {uploadNotice && (
        <OperationalResult
          severity={uploadNotice.severity}
          className={`assets-result assets-result--${uploadNotice.severity}`}
          dismissClassName="assets-result-dismiss"
          onDismiss={() => setUploadNotice(null)}
        >
          {uploadNotice.lines.map((line, index) => (
            <div key={index}>
              {text(line.message)}
              {line.items && (
                <ul className="modal-result-list">
                  {line.items.map((item, itemIndex) => (
                    <li key={`${itemIndex}:${item.name}`}>
                      {t("assets.itemReason", { name: item.name, reason: item.reason })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </OperationalResult>
      )}

      {/* Asset grid */}
      {assets.length === 0 ? (
        <div className="assets-empty">{t("assets.empty")}</div>
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
  const { t, locale } = useI18n();
  const src = assetUrl(postId, asset.filename, workspaceId);
  const img = isImage(asset.filename);

  return (
    <div className="asset-card">
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
          {formatBytes(asset.size, locale)}
          {asset.width && asset.height && (
            <> &middot; {asset.width}&times;{asset.height}</>
          )}
        </div>
        {asset.hasMetadata && (
          <div className="asset-meta-note">{t("assets.hasMetadata")}</div>
        )}
      </div>
      <div className="asset-actions">
        <button className="asset-btn" onClick={onInsert} title={t("assets.insertTitle")} disabled={readOnly}>
          {t("assets.insert")}
        </button>
        <button className="asset-btn asset-btn-delete" onClick={onDelete} title={t("common.delete")} disabled={readOnly}>
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}
