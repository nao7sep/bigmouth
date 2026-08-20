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
} from "../api";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SourcePickerModal } from "./SourcePickerModal";
import { useConfirm } from "./ConfirmHost";
import { computeCounts, type ContentCounts } from "../util/counts";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { useRadioGroup } from "../hooks/useRadioGroup";

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

const STATUS_OPTIONS: { value: PostStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "ready", label: "Ready" },
  { value: "published", label: "Published" },
  { value: "expired", label: "Expired" },
];

const STATUS_VALUES: PostStatus[] = STATUS_OPTIONS.map((o) => o.value);

// Published and expired posts are read-only; the editor locks until the post is
// moved back to Draft or Ready.
function isLockedStatus(status: PostStatus): boolean {
  return status === "published" || status === "expired";
}

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
  const [post, setPost] = useState<Post | null>(null);
  const [content, setContent] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { copiedKey, copy: copyContent } = useCopyFeedback();
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
        setLoadError(err instanceof Error ? err.message : "Failed to load post");
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
          ? `${event.message} BigMouth cannot save your changes. Your text is still here — copy it somewhere safe.`
          : "Autosave failed and will retry. Your text is held in memory until it saves."
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
    if (post && isLockedStatus(post.frontMatter.status)) return;
    setContent(value);
    notifyContentChange(value);
    setStatusError(null);
    queuePostContent(postId, value, workspaceId);
  };

  const applyStatusChange = async (newStatus: PostStatus) => {
    try {
      setStatusError(null);
      // Content needs no renderer-side flush: the main-process store writes
      // through its pending buffer as part of the status change itself.
      const flushedMetadata = (await onBeforeStatusChange?.()) ?? true;
      if (!flushedMetadata) {
        setStatusError("Metadata changes could not be saved. Resolve them before changing status.");
        return;
      }

      const updated = await changePostStatus(postId, newStatus, workspaceId);
      setPost(updated);
      onPostUpdated(updated);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Status change failed");
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
          title: "Revert to draft?",
          message:
            "This clears the ready, publication, and expiry times. The post will be treated as never published until you advance it again. Use this for a real rewrite and repost; to fix a small typo, switch to Ready instead.",
          confirmLabel: "Revert to Draft",
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
    let referrerCount = 0;
    try {
      const { count } = await listReferrers(postId, workspaceId);
      referrerCount = count;
    } catch {
      referrerCount = 0;
    }

    const ok = await confirm({
      message:
        referrerCount > 0
          ? `Delete this post? This cannot be undone. ${referrerCount} other post${referrerCount === 1 ? "" : "s"} link${referrerCount === 1 ? "s" : ""} to it as their source and will be unlinked.`
          : "Delete this post? This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;

    try {
      await deletePost(postId, workspaceId);
      onPostDeleted();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Delete failed");
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
      setStatusError(err instanceof Error ? err.message : "Failed to link source post");
    }
  };

  const handleClearSource = async () => {
    try {
      const updated = await updatePost(postId, { frontMatter: { sourceId: null } }, workspaceId);
      setPost(updated);
      onPostUpdated(updated);
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to unlink source post");
    }
  };

  if (!post) {
    return (
      <div className="pane-center">
        <div className="center-toolbar">
          <span className="toolbar-label">{loadError ? "Load failed" : "Loading…"}</span>
        </div>
        <div className="center-loading">{loadError ?? "Loading post…"}</div>
      </div>
    );
  }

  const fm = post.frontMatter;
  const locked = isLockedStatus(fm.status);
  const toolbarError = statusError ?? saveError;

  return (
    <div className="pane-center">
      <div className="center-toolbar">
        {onGoBack && (
          <button className="btn-toolbar" onClick={() => void onGoBack()}>
            ◀ Back
          </button>
        )}
        <span className="toolbar-label">{fm.target}</span>
        <span className="toolbar-sep">|</span>
        <span className="toolbar-label">{fm.language}</span>
        <span className="toolbar-sep">|</span>
        <div className="status-radios" aria-label="Post status" {...radioGroupProps}>
          {STATUS_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`status-radio${fm.status === value ? " active" : ""}`}
              {...getRadioProps(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="toolbar-sep">|</span>
        {fm.sourceId ? (
          <>
            <span
              className="toolbar-source"
              onClick={() => void onSelectPost(fm.sourceId!)}
              title={`Source: ${fm.sourceId}`}
            >
              Source
            </span>
            <button className="btn-toolbar" onClick={() => setSourcePickerOpen(true)} disabled={locked}>
              Change
            </button>
            <button className="btn-toolbar" onClick={() => void handleClearSource()} disabled={locked}>
              Unlink
            </button>
          </>
        ) : (
          <button className="btn-toolbar" onClick={() => setSourcePickerOpen(true)} disabled={locked}>
            Link Source
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn-toolbar" onClick={handleCopyContent}>
          {copiedKey === "content" ? (
            "✓ Copied"
          ) : (
            "Copy"
          )}
        </button>
        <button className="btn-toolbar" onClick={onExport}>
          Export
        </button>
        <button className="btn-toolbar btn-delete" onClick={() => void openDeleteConfirm()}>
          Delete
        </button>
      </div>
      {toolbarError && (
        <div className="toolbar-error">
          {toolbarError}
          <button
            className="toolbar-error-dismiss"
            onClick={() => {
              setStatusError(null);
              setSaveError(null);
            }}
          >
            ×
          </button>
        </div>
      )}
      {locked && (
        <div className="toolbar-notice">
          {fm.status === "published" ? (
            <>
              Published posts are locked. Switch to <strong>Ready</strong> to edit; switching to{" "}
              <strong>Draft</strong> also clears the ready and publication times.
            </>
          ) : (
            <>
              Expired posts are locked. Switch to <strong>Ready</strong> to edit, or{" "}
              <strong>Draft</strong> to clear the lifecycle times and start over.
            </>
          )}
        </div>
      )}
      <div className="center-editor">
        <MarkdownEditor
          ref={editorRef}
          content={content}
          onContentChange={handleContentChange}
          watermark={watermark}
          contentFont={contentFont}
          readOnly={locked}
        />
      </div>
      <div className="center-counts">
        <span>{counts.graphemes} graphemes</span>
        <span>{counts.xWeighted} X chars</span>
        <span>{counts.paragraphs} paragraphs</span>
        <span>avg {counts.avgParagraphLength}</span>
        <span>longest {counts.longestParagraphLength}</span>
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
