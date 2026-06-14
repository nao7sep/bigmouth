import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Post, PostMutationResult, PostStatus } from "../types";
import { fetchPost, updatePost, changePostStatus, deletePost, fetchReferrers } from "../api";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SourcePickerModal } from "./SourcePickerModal";
import { ConfirmModal } from "./ConfirmModal";
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
  editorRef?: React.Ref<MarkdownEditorHandle>;
}

export interface CenterPaneHandle {
  flushPendingChanges: () => Promise<boolean>;
}

const AUTO_SAVE_DELAY = 2_000;

const STATUS_OPTIONS: { value: PostStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "checked", label: "Checked" },
  { value: "published", label: "Published" },
];

const STATUS_VALUES: PostStatus[] = STATUS_OPTIONS.map((o) => o.value);

export const CenterPane = forwardRef<CenterPaneHandle, CenterPaneProps>(function CenterPane(
  {
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
    editorRef,
  },
  ref
) {
  const [post, setPost] = useState<Post | null>(null);
  const [content, setContent] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { copiedKey, copy: copyContent } = useCopyFeedback();
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [referrerCount, setReferrerCount] = useState(0);
  const [draftRevertConfirmOpen, setDraftRevertConfirmOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef("");
  const savedContentRef = useRef("");
  const pendingSaveRef = useRef(false);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const onPostUpdatedRef = useRef(onPostUpdated);

  useEffect(() => {
    onPostUpdatedRef.current = onPostUpdated;
  }, [onPostUpdated]);

  const save = useCallback((): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (contentRef.current === savedContentRef.current) {
      return savePromiseRef.current ?? Promise.resolve();
    }

    pendingSaveRef.current = true;
    if (savePromiseRef.current) {
      return savePromiseRef.current;
    }

    const promise = (async () => {
      try {
        while (pendingSaveRef.current) {
          pendingSaveRef.current = false;
          const current = contentRef.current;
          if (current === savedContentRef.current) continue;

          try {
            const updated = await updatePost(postId, { content: current }, workspaceId);
            savedContentRef.current = current;
            setSaveError(null);
            setPost(updated);
            onPostUpdatedRef.current(updated);
          } catch (err) {
            setSaveError(
              err instanceof Error
                ? err.message
                : "Autosave failed. Changes are still local until a save succeeds."
            );
            break;
          }

          if (contentRef.current !== savedContentRef.current) {
            pendingSaveRef.current = true;
          }
        }
      } finally {
        savePromiseRef.current = null;
      }
    })();

    savePromiseRef.current = promise;
    return promise;
  }, [postId, workspaceId]);

  const flushPendingContent = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (contentRef.current !== savedContentRef.current) {
      await save();
    } else if (savePromiseRef.current) {
      await savePromiseRef.current;
    }

    const flushed = contentRef.current === savedContentRef.current;
    if (!flushed) {
      setSaveError("Autosave failed. Resolve it before leaving this post.");
    }
    return flushed;
  }, [save]);

  useImperativeHandle(
    ref,
    () => ({
      flushPendingChanges: flushPendingContent,
    }),
    [flushPendingContent]
  );

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);

    fetchPost(postId, workspaceId)
      .then((loaded) => {
        if (cancelled) return;
        setPost(loaded);
        setContent(loaded.content);
        contentRef.current = loaded.content;
        savedContentRef.current = loaded.content;
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

  // Drop the pending debounce timer on unmount so a stray autosave never fires
  // after the post is gone. Intentional teardowns (post switch, status change,
  // workspace switch) flush explicitly via flushPendingChanges first; a delete
  // deliberately discards unsaved edits.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleContentChange = (value: string) => {
    // Published posts are locked; the editor is read-only, but guard the save
    // path too so a stray change can never autosave into a locked post.
    if (post?.frontMatter.status === "published") return;
    setContent(value);
    contentRef.current = value;
    notifyContentChange(value);
    setStatusError(null);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), AUTO_SAVE_DELAY);
  };

  const applyStatusChange = async (newStatus: PostStatus) => {
    try {
      setStatusError(null);
      const flushedContent = await flushPendingContent();
      if (!flushedContent) {
        setStatusError("Current content could not be saved. Resolve it before changing status.");
        return;
      }

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
    // Moving to draft clears the checked and publication timestamps. Warn
    // whenever a publication time would actually be lost — this also covers the
    // published → checked → draft path, where the status is already "checked"
    // but publishedAtUtc is still set. published → checked itself is
    // non-destructive (both timestamps are kept) and needs no prompt.
    if (newStatus === "draft" && post.frontMatter.publishedAtUtc) {
      setDraftRevertConfirmOpen(true);
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
    try {
      const { count } = await fetchReferrers(postId, workspaceId);
      setReferrerCount(count);
    } catch {
      setReferrerCount(0);
    }
    setDeleteConfirmOpen(true);
  };

  const handleDelete = async () => {
    setDeleteConfirmOpen(false);
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
  const locked = fm.status === "published";
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
          Published posts are locked. Switch to <strong>Checked</strong> to edit; switching to{" "}
          <strong>Draft</strong> also clears the publication time.
        </div>
      )}
      <div className="center-editor">
        <MarkdownEditor
          ref={editorRef}
          content={content}
          onContentChange={handleContentChange}
          watermark={watermark}
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
      {deleteConfirmOpen && (
        <ConfirmModal
          message={
            referrerCount > 0
              ? `Delete this post? This cannot be undone. ${referrerCount} other post${referrerCount === 1 ? "" : "s"} link${referrerCount === 1 ? "s" : ""} to it as their source and will be unlinked.`
              : "Delete this post? This cannot be undone."
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
      {draftRevertConfirmOpen && (
        <ConfirmModal
          title="Revert to draft?"
          message="This clears the publication time and the checked time. The post will be treated as never published until you publish it again. Use this for a real rewrite and repost; to fix a small typo, switch to Checked instead."
          confirmLabel="Revert to Draft"
          danger
          onConfirm={() => {
            setDraftRevertConfirmOpen(false);
            void applyStatusChange("draft");
          }}
          onCancel={() => setDraftRevertConfirmOpen(false)}
        />
      )}
    </div>
  );
});
