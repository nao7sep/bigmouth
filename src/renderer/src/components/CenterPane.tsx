import { useEffect, useRef, useState } from "react";
import type { ContentFont, Post, PostMutationResult, PostStatus } from "@shared/types";
import {
  getPost,
  updatePost,
  changePostStatus,
  deletePost,
  listReferrers,
  queuePostContent,
  onPostContentSaved,
  onPostContentSaveFailed,
  reportProblem,
} from "../api";
import { presentFailure } from "../util/presentFailure";
import { POST_STATUSES, POST_STATUS_LABELS, isEditLocked } from "@shared/postStatus";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SourcePickerModal } from "./SourcePickerModal";
import { useConfirm } from "./ConfirmHost";
import { computeCounts, type ContentCounts } from "../util/counts";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { useRadioGroup } from "../hooks/useRadioGroup";
import { CheckIcon, ChevronLeftIcon } from "./Icon";
import { OperationalResult } from "./OperationalResult";

interface CenterPaneProps {
  workspaceId: string;
  postId: string;
  onPostUpdated: (result: PostMutationResult) => void;
  onPostDeleted: () => void;
  onContentChange: (content: string) => void;
  onPostLoaded: (post: Post) => void;
  onExport: () => void;
  onSelectPost: (id: string) => void;
  onGoBack?: () => void;
  onBeforeStatusChange?: () => Promise<boolean>;
  pubBatchSize: number;
  watermark: string;
  contentFont: ContentFont;
  editorRef?: React.Ref<MarkdownEditorHandle>;
}

const STATUS_VALUES: PostStatus[] = [...POST_STATUSES];

// Published and expired posts are read-only; the editor locks until the post is
// moved back to Draft or Ready.

export function CenterPane({
  workspaceId,
  postId,
  onPostUpdated,
  onPostDeleted,
  onContentChange: notifyContentChange,
  onPostLoaded,
  onExport,
  onSelectPost,
  onGoBack,
  onBeforeStatusChange,
  pubBatchSize,
  watermark,
  contentFont,
  editorRef,
}: CenterPaneProps) {
  const { t, text, rich } = useI18n();
  const [post, setPost] = useState<Post | null>(null);
  const [content, setContent] = useState("");
  const [statusError, setStatusError] = useState<Message | null>(null);
  // True while a delete confirmation is open or resolving. See openDeleteConfirm.
  const deletingRef = useRef(false);
  const [saveError, setSaveError] = useState<Message | null>(null);
  const [loadError, setLoadError] = useState<Message | null>(null);
  const {
    copiedKey,
    copy: copyContent,
    copyErrors,
    dismissCopyError,
  } = useCopyFeedback();
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const confirm = useConfirm();
  const onPostUpdatedRef = useRef(onPostUpdated);

  useEffect(() => {
    onPostUpdatedRef.current = onPostUpdated;
  }, [onPostUpdated]);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);

    getPost(postId, workspaceId)
      .then((loaded) => {
        if (cancelled) return;
        setPost(loaded);
        setContent(loaded.content);
        notifyContentChange(loaded.content);
        onPostLoaded(loaded);
        setStatusError(null);
        setSaveError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(presentFailure(
          message("center.loadFailed"),
          "renderer: post load failed",
          err,
          { postId },
        ));
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Content saves are owned by the main-process post store (write-behind):
  // every edit streams there immediately, so navigating away, switching
  // workspaces, or quitting can never orphan text in a renderer debounce.
  // Save results come back as events; failures show inline. A retryable failure
  // keeps the text safe in the store's buffer, while a terminal one says so
  // plainly — the editor's copy is then the one the user must rescue.
  useEffect(() => {
    const offSaved = onPostContentSaved((event) => {
      if (event.postId !== postId) return;
      // The event carries only the list projection (no updatedAtUtc — the index
      // excludes it), so there is nothing here to fold into the open post.
      setSaveError(null);
    });
    const offFailed = onPostContentSaveFailed((event) => {
      if (event.postId !== postId) return;
      setSaveError(
        event.kind === "unsaveable"
          ? message("center.unsaveable")
          : message("center.autosaveRetrying")
      );
    });
    return () => {
      offSaved();
      offFailed();
    };
  }, [postId]);

  const handleContentChange = (value: string) => {
    // Published and expired posts are locked; the editor is read-only, but guard
    // the save path too so a stray change can never autosave into a locked post.
    if (post && isEditLocked(post.frontMatter.status)) return;
    setContent(value);
    notifyContentChange(value);
    setStatusError(null);
    queuePostContent(postId, value, workspaceId);
  };

  const applyStatusChange = async (newStatus: PostStatus) => {
    try {
      setStatusError(null);
      // No edit needs a renderer-side flush: the main-process store writes its
      // pending content and metadata as part of the status change itself. The
      // Metadata tab only reports a value the store refused.
      const flushedMetadata = (await onBeforeStatusChange?.()) ?? true;
      if (!flushedMetadata) {
        setStatusError(message("center.metadataUnsaved"));
        return;
      }

      const updated = await changePostStatus(postId, newStatus, workspaceId);
      setPost(updated);
      onPostUpdated(updated);
    } catch (err) {
      setStatusError(presentFailure(
        message("center.statusFailed"),
        "renderer: post status change failed",
        err,
        { postId, newStatus },
      ));
    }
  };

  const handleStatusChange = (newStatus: PostStatus) => {
    if (!post || post.frontMatter.status === newStatus) return;
    // Moving to draft clears the ready, publication, and expiry timestamps.
    // Warn whenever a publication or expiry time would actually be lost — this
    // also covers the published → ready → draft path, where the status is
    // already "ready" but publishedAtUtc is still set. published → ready
    // itself is non-destructive (timestamps are kept) and needs no prompt.
    if (newStatus === "draft" && (post.frontMatter.publishedAtUtc || post.frontMatter.expiredAtUtc)) {
      void (async () => {
        const ok = await confirm({
          title: t("center.revertTitle"),
          message: t("center.revertMessage"),
          confirmLabel: t("center.revertConfirm"),
          danger: true,
        });
        if (ok) void applyStatusChange("draft");
      })();
      return;
    }
    void applyStatusChange(newStatus);
  };

  // Status switcher: a manual-activation radiogroup, so arrowing only moves the
  // cursor and Space/Enter (or a click) commits — a status change flushes saves
  // and hits the network, so it must not fire on focus move the way a native
  // radio would. `value` falls back to "draft" only while no post is loaded (the
  // group isn't rendered then).
  const { radioGroupProps, getRadioProps } = useRadioGroup<PostStatus>({
    values: STATUS_VALUES,
    value: post?.frontMatter.status ?? "draft",
    onCommit: handleStatusChange,
  });

  const openDeleteConfirm = async () => {
    // One at a time. Nothing disabled the button and nothing guarded re-entry,
    // so two fast clicks queued two confirms: the first deleted the post and
    // moved the selection, then the second asked to delete a post that was
    // already gone and ran deletePost on the stale id from an unmounted pane.
    if (deletingRef.current) return;
    deletingRef.current = true;
    try {
      await runDeleteConfirm();
    } finally {
      deletingRef.current = false;
    }
  };

  const runDeleteConfirm = async () => {
    let referrerCount = 0;
    try {
      const { count } = await listReferrers(postId, workspaceId);
      referrerCount = count;
    } catch (err) {
      // The confirmation silently loses the "N posts link to this" clause, so a
      // destructive prompt gets weaker without anyone knowing why.
      reportProblem("referrer count unavailable for the delete confirmation", err, { postId });
      referrerCount = 0;
    }

    const ok = await confirm({
      message:
        referrerCount > 0
          ? t("center.deleteWithReferrers", { count: referrerCount })
          : t("center.deleteMessage"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;

    try {
      await deletePost(postId, workspaceId);
      onPostDeleted();
    } catch (err) {
      setStatusError(presentFailure(
        message("center.deleteFailed"),
        "renderer: post deletion failed",
        err,
        { postId },
      ));
    }
  };

  const [counts, setCounts] = useState<ContentCounts>({
    graphemes: 0,
    xWeighted: 0,
    paragraphs: 0,
    avgParagraphLength: 0,
    longestParagraphLength: 0,
  });
  const countsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (countsTimerRef.current) clearTimeout(countsTimerRef.current);
    countsTimerRef.current = setTimeout(() => {
      setCounts(computeCounts(content));
    }, 100);
    return () => {
      if (countsTimerRef.current) clearTimeout(countsTimerRef.current);
    };
  }, [content]);

  const handleCopyContent = () => copyContent(content, "content");

  const handleSetSource = async (sourceId: string) => {
    try {
      const updated = await updatePost(postId, { frontMatter: { sourceId } }, workspaceId);
      setPost(updated);
      onPostUpdated(updated);
      setStatusError(null);
    } catch (err) {
      setStatusError(presentFailure(
        message("center.linkFailed"),
        "renderer: source post link failed",
        err,
        { postId, sourceId },
      ));
    }
  };

  const handleClearSource = async () => {
    try {
      const updated = await updatePost(postId, { frontMatter: { sourceId: null } }, workspaceId);
      setPost(updated);
      onPostUpdated(updated);
      setStatusError(null);
    } catch (err) {
      setStatusError(presentFailure(
        message("center.unlinkFailed"),
        "renderer: source post unlink failed",
        err,
        { postId },
      ));
    }
  };

  if (!post) {
    return (
      <div className="pane-center">
        <div className="center-toolbar">
          <span className="toolbar-label">{loadError ? t("center.loadFailedLabel") : t("common.loading")}</span>
        </div>
        <div className="center-loading">{loadError ? text(loadError) : t("center.loadingPost")}</div>
      </div>
    );
  }

  const fm = post.frontMatter;
  const locked = isEditLocked(fm.status);
  const toolbarError = statusError ?? saveError;

  return (
    <div className="pane-center">
      <div className="center-toolbar">
        {onGoBack && (
          <button className="btn-toolbar" onClick={() => void onGoBack()}>
            <ChevronLeftIcon /> {t("center.back")}
          </button>
        )}
        <span className="toolbar-label">{fm.target}</span>
        <span className="toolbar-sep" aria-hidden="true" />
        <span className="toolbar-label">{fm.language}</span>
        <span className="toolbar-sep" aria-hidden="true" />
        <div className="status-radios" aria-label={t("center.postStatus")} {...radioGroupProps}>
          {STATUS_VALUES.map((value) => (
            <button
              key={value}
              type="button"
              className={`status-radio${fm.status === value ? " active" : ""}`}
              {...getRadioProps(value)}
            >
              {t(POST_STATUS_LABELS[value])}
            </button>
          ))}
        </div>
        <span className="toolbar-sep" aria-hidden="true" />
        {fm.sourceId ? (
          <>
            {/* A real button: it was a <span> with an onClick and a pointer
                cursor, which no keyboard could reach at all. */}
            <button
              type="button"
              className="toolbar-source"
              onClick={() => void onSelectPost(fm.sourceId!)}
              title={t("center.sourceTitle", { id: fm.sourceId })}
            >
              {t("center.source")}
            </button>
            <button className="btn-toolbar" onClick={() => setSourcePickerOpen(true)} disabled={locked}>
              {t("center.change")}
            </button>
            <button className="btn-toolbar" onClick={() => void handleClearSource()} disabled={locked}>
              {t("newPost.unlink")}
            </button>
          </>
        ) : (
          <button className="btn-toolbar" onClick={() => setSourcePickerOpen(true)} disabled={locked}>
            {t("center.linkSource")}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn-toolbar" onClick={handleCopyContent}>
          {copiedKey === "content" ? (
            <>
              <CheckIcon /> {t("common.copied")}
            </>
          ) : (
            t("common.copy")
          )}
        </button>
        <button className="btn-toolbar" onClick={onExport}>
          {t("export.title")}
        </button>
        <button className="btn-toolbar btn-delete" onClick={() => void openDeleteConfirm()}>
          {t("common.delete")}
        </button>
      </div>
      {copyErrors.content && (
        <OperationalResult
          severity="error"
          className="toolbar-error"
          dismissClassName="toolbar-error-dismiss"
          onDismiss={() => dismissCopyError("content")}
        >
          {text(copyErrors.content)}
        </OperationalResult>
      )}
      {toolbarError && (
        <OperationalResult
          severity="error"
          className="toolbar-error"
          dismissClassName="toolbar-error-dismiss"
          onDismiss={() => {
              setStatusError(null);
              setSaveError(null);
          }}
        >
          {text(toolbarError)}
        </OperationalResult>
      )}
      {locked && (
        <div className="toolbar-notice">
          {rich(fm.status === "published" ? "center.publishedLocked" : "center.expiredLocked", {
            ready: <strong>{t("status.ready")}</strong>,
            draft: <strong>{t("status.draft")}</strong>,
          })}
        </div>
      )}
      <div className="center-editor">
        <MarkdownEditor
          ref={editorRef}
          initialContent={content}
          onContentChange={handleContentChange}
          watermark={watermark}
          contentFont={contentFont}
          readOnly={locked}
        />
      </div>
      <div className="center-counts">
        <span>{t("center.graphemes", { count: counts.graphemes })}</span>
        <span>{t("center.xChars", { count: counts.xWeighted })}</span>
        <span>{t("center.paragraphs", { count: counts.paragraphs })}</span>
        <span>{t("center.average", { value: counts.avgParagraphLength })}</span>
        <span>{t("center.longest", { value: counts.longestParagraphLength })}</span>
      </div>

      {sourcePickerOpen && (
        <SourcePickerModal
          currentPostId={postId}
          pubBatchSize={pubBatchSize}
          onSelect={handleSetSource}
          onClose={() => setSourcePickerOpen(false)}
        />
      )}
    </div>
  );
}
