import { useCallback, useEffect, useRef, useState } from "react";
import type { HTMLAttributes } from "react";
import { onWindowActivated, listAssets, uploadAsset, deleteAsset, assetUrl, assetDerivativeUrl, reportProblem } from "../api";
import { assetPicture } from "../util/assetImages";
import { clearPostAssets, publishPostAssets, usePostAssets } from "../hooks/usePostAssets";
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
import { ListedMessageView, type ListedMessage, type NamedItem } from "./NamedItems";
import { inspectAssetDragOffer } from "../util/assetDrop";
import { AssetUploadAdmissionError, AssetUploadFailureError } from "../util/assetUpload";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import { carriedMessage } from "@shared/i18n/carriedMessage";
import { useStorageResultReporter } from "../StorageResults";

interface AssetsTabProps extends Pick<
  HTMLAttributes<HTMLDivElement>,
  "aria-labelledby" | "className" | "id" | "role"
> {
  workspaceId: string;
  postId: string;
  onInsertAtCursor: (text: string) => void;
  locked?: boolean;
}

type DragState = "idle" | "delivery" | "accepting" | "rejecting";
// One line of a notice. A line about several files names a few and keeps the
// whole list, with each file's reason, behind a disclosure.
type NoticeLine = ListedMessage;
type AssetNotice = {
  severity: "warning" | "error";
  lines: NoticeLine[];
  issueKeys: string[];
};

function notAdded(items: Array<{ file: File; reason: Message }>, count = items.length): NoticeLine {
  return {
    message: message("assets.notAdded", { count }),
    items: items.map(({ file, reason }) => ({
      name: file.name,
      line: message("assets.itemReason", { name: file.name, reason }),
    })),
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

/**
 * The picture on an asset's card: a still image's thumbnail, an animated image
 * as itself, or the file-type tile for other files and for an image whose
 * picture cannot be loaded. Pictures load only as their cards scroll into view
 * and decode off the main thread.
 */
function AssetPicture({ asset, postId, workspaceId }: { asset: AssetMeta; postId: string; workspaceId: string }) {
  const picture = assetPicture(asset);
  const src = picture.kind === "derived"
    ? assetDerivativeUrl("thumb", picture.contentHash)
    : picture.kind === "original" ? assetUrl(postId, asset.filename, workspaceId) : null;
  // Keyed by URL, so a replaced image tries its new picture.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src === null || failedSrc === src) {
    return <div className="asset-file-icon">{ext(asset.filename).toUpperCase()}</div>;
  }
  return <img src={src} alt={asset.filename} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />;
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
  locked = false,
  ...containerProps
}: AssetsTabProps) {
  const { t, text, list } = useI18n();
  const reportStorageResult = useStorageResultReporter();
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const showNotice = (notice: AssetNotice) => {
    if (current.current) { setUploadNotice(notice); return; }
    for (const line of notice.lines) reportStorageResult(line, notice.severity);
  };
  // Assets owns the single listing request; Preview subscribes to the same projection.
  const projection = usePostAssets(workspaceId, postId);
  const assets = projection ?? [];
  const [listingPending, setListingPending] = useState(true);
  const listingVersion = useRef(0);
  const [loadError, setLoadError] = useState<Message | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  const [dismissedUnavailable, setDismissedUnavailable] = useState<string | null>(null);
  const unavailableIdentity = JSON.stringify(unavailable);
  const [uploading, setUploading] = useState(false);
  const [dragState, setDragState] = useState<DragState>("idle");
  const [uploadNotice, setUploadNotice] = useState<AssetNotice | null>(null);
  // Its own slot, so no later upload result replaces it before it is read.
  const [recoveryNotice, setRecoveryNotice] = useState<Message | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const assetsRef = useRef<AssetMeta[]>([]);
  const uploadTailRef = useRef<Promise<void>>(Promise.resolve());
  const queuedUploadsRef = useRef(0);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const confirm = useConfirm();

  const resetDragState = useCallback(() => {
    setDragState("idle");
  }, []);

  const load = useCallback(async (): Promise<Message | null> => {
    if (!current.current) return null;
    const version = ++listingVersion.current;
    setListingPending(true);
    try {
      const { assets: list, movedAside, unavailable = [] } = await listAssets(postId, workspaceId);
      if (!current.current || listingVersion.current !== version) {
        if (movedAside) reportStorageResult(message("assets.metaMovedAside", { ...movedAside }), "warning");
        return null;
      }
      setLoadError(null);
      setUnavailable(unavailable);
      if (unavailable.length === 0) setDismissedUnavailable(null);
      assetsRef.current = list;
      publishPostAssets(workspaceId, postId, list);
      if (movedAside) setRecoveryNotice(message("assets.metaMovedAside", { ...movedAside }));
      return null;
    } catch (err) {
      if (!current.current || listingVersion.current !== version) return null;
      publishPostAssets(workspaceId, postId, null);
      return presentFailure(
        message("assets.loadFailed"),
        "renderer: asset list failed",
        err,
        { postId },
      );
    } finally {
      if (current.current && listingVersion.current === version) setListingPending(false);
    }
  }, [postId, workspaceId, reportStorageResult]);

  useEffect(() => {
    assetsRef.current = [];
    setUnavailable([]);
    setDismissedUnavailable(null);
    clearPostAssets(workspaceId, postId);
    setLoadError(null);
    setUploadNotice(null);
    setRecoveryNotice(null);
    const refresh = () => void load().then((failure) => {
      if (failure && current.current) setLoadError(failure);
    });
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onWindowActivated(() => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    });
    return () => {
      ++listingVersion.current;
      off();
      clearTimeout(timer);
    };
  }, [load]);

  const uploadFiles = async (
    files: File[],
    rejected: Array<{ file: File; reason: Message }>,
    operationKeys: string[],
  ) => {
    if (locked) return;
    const admissionFailures: Array<{ file: File; reason: Message }> = [];
    const operationalFailures: Array<{ file: File; reason: Message }> = [];
    // Added, but something that records the addition could not be saved.
    const unsaved: NamedItem[] = [];
    for (const file of files) {
      try {
        const { asset, unsaved: unsavedParts } = await uploadAsset(postId, file, workspaceId);
        if (unsavedParts?.includes("details")) {
          unsaved.push({ name: asset.filename, line: message("assets.addedWithoutDetails", { name: asset.filename }) });
        }
        if (unsavedParts?.includes("modifiedTime")) {
          unsaved.push({ name: asset.filename, line: message("assets.addedWithoutPostTime", { name: asset.filename }) });
        }
      } catch (err) {
        if (err instanceof AssetUploadAdmissionError) {
          admissionFailures.push({ file, reason: err.reason });
        } else if (err instanceof AssetUploadFailureError) {
          // Said in the words of what went wrong: the file could not be read,
          // or the workspace folder could not take it.
          operationalFailures.push({ file, reason: err.reason });
          reportProblem("Asset upload failed.", err, { postId, filename: file.name });
        } else {
          // A failure that carries its own words, such as a meta.json a newer
          // version saved, is told in them.
          operationalFailures.push({ file, reason: carriedMessage(err) ?? message("assets.fileNotAdded") });
          reportProblem("Asset upload failed.", err, { postId, filename: file.name });
        }
      }
    }
    const refreshFailure = await load();
    const invalid = [...rejected, ...admissionFailures];
    if (invalid.length > 0 || operationalFailures.length > 0 || unsaved.length > 0 || refreshFailure) {
      const addedCount = files.length - admissionFailures.length - operationalFailures.length;
      const lines: NoticeLine[] = [];
      if (addedCount > 0) lines.push({ message: message("assets.added", { count: addedCount }) });
      if (unsaved.length > 0) {
        const count = new Set(unsaved.map((item) => item.name)).size;
        lines.push({ message: message("assets.addedIncomplete", { count }), items: unsaved });
      }
      if (invalid.length > 0) lines.push(notAdded(invalid));
      if (operationalFailures.length > 0) lines.push(notAdded(operationalFailures));
      if (refreshFailure) lines.push({ message: refreshFailure });
      showNotice({
        severity: operationalFailures.length > 0 || refreshFailure ? "error" : "warning",
        lines,
        issueKeys: [
          ...(unsaved.length > 0 ? files.map(assetIssueKey) : []),
          ...invalid.map(({ file }) => assetIssueKey(file)),
          ...operationalFailures.map(({ file }) => assetIssueKey(file)),
          ...(refreshFailure ? [`refresh:${postId}`] : []),
        ],
      });
    } else {
      if (current.current) setUploadNotice((current) => {
        if (current === null) return null;
        const resolvedKeys = [...operationKeys, `refresh:${postId}`];
        if (coversIssueKeys(resolvedKeys, current.issueKeys)) return null;
        return current;
      });
    }
  };

  const checkAndUpload = async (files: FileList | File[]) => {
    if (locked) return;
    const fileArray = Array.from(files);
    const reserved = fileArray.filter((file) => isReservedAssetName(sanitizeAssetFilename(file.name)));
    const uploadable = fileArray.filter((file) => !isReservedAssetName(sanitizeAssetFilename(file.name)));
    const rejected = reserved.map((file) => ({ file, reason: message("assets.reservedName") }));
    const operationKeys = fileArray.map(assetIssueKey);

    if (uploadable.length === 0) {
      if (rejected.length > 0) {
        showNotice({
          severity: "warning",
          lines: [notAdded(rejected)],
          issueKeys: rejected.map(({ file }) => assetIssueKey(file)),
        });
      }
      return;
    }

    const batchCollisions = collidingAssetFilenames(uploadable.map((file) => file.name));
    if (batchCollisions.length > 0) {
      showNotice({
        severity: "warning",
        lines: [
          notAdded(rejected, fileArray.length),
          // The sentence names a few of the colliding names itself.
          { message: message("assets.collision"), items: batchCollisions.map((name) => ({ name })), namesIn: "names" },
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
      if (!current.current) {
        showNotice({ severity: "warning", lines: [notAdded(uploadable.map((file) => ({ file, reason: message("assets.fileNotAdded") })))], issueKeys: operationKeys });
        return;
      }
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
    if (captured.length === 0 || deletingRef.current) return;
    queuedUploadsRef.current += 1;
    setUploading(true);
    const operation = uploadTailRef.current.then(() => checkAndUpload(captured));
    uploadTailRef.current = operation.catch(() => undefined);
    try {
      await operation;
    } catch (err) {
      reportProblem("Asset upload transaction failed.", err, { postId });
      showNotice({
        severity: "error",
        lines: [{ message: message("assets.addFailed") }],
        issueKeys: captured.map(assetIssueKey),
      });
    } finally {
      queuedUploadsRef.current -= 1;
      if (queuedUploadsRef.current === 0 && current.current) setUploading(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    resetDragState();
    // Always neutralize the webview's native text/URL/file drop behavior before
    // deciding whether this drop belongs to the asset importer.
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "none";
    if (locked) {
      showNotice({
        severity: "warning",
        lines: [{ message: message("assets.locked") }],
        issueKeys: ["receiver:read-only"],
      });
      return;
    }
    if (e.dataTransfer.files.length === 0) {
      showNotice({
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
    if (locked || queuedUploadsRef.current > 0 || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
    const ok = await confirm({
      message: t("assets.deleteMessage", { name: filename }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      const { unsaved } = await deleteAsset(postId, filename, workspaceId);
      if (current.current) {
        // Retire a refresh started before deletion so it cannot restore the removed card.
        ++listingVersion.current;
        setListingPending(false);
        assetsRef.current = assetsRef.current.filter((a) => a.filename !== filename);
        publishPostAssets(workspaceId, postId, assetsRef.current);
      }
      if (unsaved?.includes("modifiedTime")) {
        showNotice({
          severity: "warning",
          lines: [{ message: message("assets.deletedWithoutPostTime", { name: filename }) }],
          issueKeys: [`delete:${filename}`],
        });
      }
    } catch (err) {
      reportProblem("Asset deletion failed.", err, { postId, filename });
      // Show the attachments as they now are, whatever the failure left.
      if (current.current) void load();
      const carried = carriedMessage(err);
      showNotice({
        severity: "error",
        lines: [
          { message: message("assets.deleteFailed", { name: filename }) },
          ...(carried ? [{ message: carried }] : []),
        ],
        issueKeys: [`delete:${filename}`],
      });
    }
    } finally { deletingRef.current = false; if (current.current) setDeleting(false); }
  };

  const handleInsert = (filename: string) => {
    if (locked) return;
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
      aria-disabled={locked || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const offer = inspectAssetDragOffer(e.dataTransfer);
        if (locked || offer === "rejected") {
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
          {locked ? t("assets.lockedNote") : t("assets.dropNote")}
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
          disabled={locked || uploading || deleting}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? t("assets.adding") : t("assets.add")}
        </button>
      </div>

      {recoveryNotice && (
        <OperationalResult
          severity="warning"
          className="assets-result assets-result--warning"
          dismissClassName="assets-result-dismiss"
          onDismiss={() => setRecoveryNotice(null)}
        >
          {text(recoveryNotice)}
        </OperationalResult>
      )}

      {uploadNotice && (
        <OperationalResult
          severity={uploadNotice.severity}
          className={`assets-result assets-result--${uploadNotice.severity}`}
          dismissClassName="assets-result-dismiss"
          onDismiss={() => setUploadNotice(null)}
        >
          {uploadNotice.lines.map((line, index) => (
            <div key={index}>
              <ListedMessageView listed={line} />
            </div>
          ))}
        </OperationalResult>
      )}

      {loadError && (
        <OperationalResult severity="error" className="assets-result assets-result--error" dismissClassName="assets-result-dismiss" onDismiss={() => setLoadError(null)}>
          {text(loadError)}
        </OperationalResult>
      )}

      {unavailable.length > 0 && dismissedUnavailable !== unavailableIdentity && (
        <OperationalResult severity="warning" className="assets-result assets-result--warning"
          dismissClassName="assets-result-dismiss" onDismiss={() => setDismissedUnavailable(unavailableIdentity)}>
          <ListedMessageView listed={{ message: message("assets.unavailable"), items: unavailable.map(name => ({ name })), namesIn: "names" }} />
        </OperationalResult>
      )}

      {/* Asset grid */}
      {listingPending && projection === undefined ? (
        <div className="assets-empty" role="status">{t("common.loading")}</div>
      ) : projection === null ? null : assets.length === 0 ? (
        unavailable.length === 0 ? <div className="assets-empty">{t("assets.empty")}</div> : null
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
                locked={locked || uploading || deleting}
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
  locked,
}: {
  workspaceId: string;
  postId: string;
  asset: AssetMeta;
  onInsert: () => void;
  onDelete: () => void;
  locked: boolean;
}) {
  const { t, locale } = useI18n();

  return (
    <div className="asset-card">
      <div className="asset-thumb">
        <AssetPicture asset={asset} postId={postId} workspaceId={workspaceId} />
      </div>
      <div className="asset-info">
        {/* Beside the fixed-height thumbnail the name gets two lines, then an
            ellipsis that keeps its beginning; hovering shows it whole. */}
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
        <button className="asset-btn" onClick={onInsert} title={t("assets.insertTitle")} disabled={locked}>
          {t("assets.insert")}
        </button>
        <button className="asset-btn asset-btn-delete" onClick={onDelete} title={t("common.delete")} disabled={locked}>
          {t("common.delete")}
        </button>
      </div>
    </div>
  );
}
