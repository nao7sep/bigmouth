import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Post, PostStatus } from "../types";
import { fetchPost, updatePost, changePostStatus, deletePost } from "../api";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SourcePickerModal } from "./SourcePickerModal";
import { ConfirmModal } from "./ConfirmModal";
import { computeCounts, type ContentCounts } from "../util/counts";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

export interface CenterPaneHandle {
  save: () => void;
}

interface CenterPaneProps {
  postId: string;
  onPostSaved: () => void;
  onPostDeleted: () => void;
  onContentChange: (content: string) => void;
  onPostLoaded: (post: Post) => void;
  onExport: () => void;
  onSelectPost: (id: string) => void;
  onGoBack?: () => void;
  pubBatchSize: number;
  watermark: string;
  editorRef?: React.Ref<MarkdownEditorHandle>;
}

const AUTO_SAVE_DELAY = 30_000;

export const CenterPane = forwardRef<CenterPaneHandle, CenterPaneProps>(
  function CenterPane({
  postId,
  onPostSaved,
  onPostDeleted,
  onContentChange: notifyContentChange,
  onPostLoaded,
  onExport,
  onSelectPost,
  onGoBack,
  pubBatchSize,
  watermark,
  editorRef,
}: CenterPaneProps, ref) {
  const [post, setPost] = useState<Post | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const { copiedKey, copy: copyContent } = useCopyFeedback();
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef(content);
  const postIdRef = useRef(postId);
  const dirtyRef = useRef(dirty);

  // Keep refs in sync
  contentRef.current = content;
  postIdRef.current = postId;
  dirtyRef.current = dirty;

  const save = useCallback(async () => {
    if (!dirtyRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      const updated = await updatePost(postIdRef.current, {
        content: contentRef.current,
      });
      setPost(updated);
      setDirty(false);
      onPostSaved();
    } catch {
      // Save failed silently — will retry on next change
    }
  }, [onPostSaved]);

  useImperativeHandle(ref, () => ({ save }), [save]);

  // Load post when postId changes (save current first)
  useEffect(() => {
    let cancelled = false;

    const loadPost = async () => {
      const loaded = await fetchPost(postId);
      if (cancelled) return;
      setPost(loaded);
      setContent(loaded.content);
      notifyContentChange(loaded.content);
      onPostLoaded(loaded);
      setDirty(false);
      setStatusError(null);
    };

    if (dirtyRef.current) {
      save().then(loadPost);
    } else {
      loadPost();
    }

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [postId, save]);

  // Debounced auto-save on content change
  const handleContentChange = (value: string) => {
    setContent(value);
    notifyContentChange(value);
    setDirty(true);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      save();
    }, AUTO_SAVE_DELAY);
  };

  // Save on unmount
  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        updatePost(postIdRef.current, { content: contentRef.current }).catch(
          () => {}
        );
      }
    };
  }, []);

  const handleStatusChange = async (newStatus: PostStatus) => {
    if (!post || post.frontMatter.status === newStatus) return;

    // Save any pending content first
    if (dirtyRef.current) await save();

    try {
      setStatusError(null);
      const updated = await changePostStatus(postId, newStatus);
      setPost(updated);
      onPostSaved();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Status change failed");
    }
  };

  const handleDelete = async () => {
    setDeleteConfirmOpen(false);
    try {
      await deletePost(postId);
      onPostDeleted();
    } catch {
      // Deletion failed — keep the post open
    }
  };

  // Debounced character counts (~100ms)
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
    const updated = await updatePost(postId, { frontMatter: { sourceId } }).catch(() => null);
    if (updated) { setPost(updated); onPostLoaded(updated); onPostSaved(); }
  };

  const handleClearSource = async () => {
    const updated = await updatePost(postId, { frontMatter: { sourceId: null } }).catch(() => null);
    if (updated) { setPost(updated); onPostLoaded(updated); onPostSaved(); }
  };

  if (!post) return null;

  const fm = post.frontMatter;

  return (
    <div className="pane-center">
      <div className="center-toolbar">
        {onGoBack && (
          <button className="btn-toolbar" onClick={onGoBack}>
            ← Back
          </button>
        )}
        <span className="toolbar-label">{fm.target}</span>
        <span className="toolbar-sep">|</span>
        <span className="toolbar-label">{fm.language}</span>
        <span className="toolbar-sep">|</span>
        <select
          className="toolbar-status"
          value={fm.status}
          onChange={(e) => handleStatusChange(e.target.value as PostStatus)}
        >
          <option value="draft">Draft</option>
          <option value="ready">Ready</option>
          <option value="published">Published</option>
        </select>
        {dirty && <span className="toolbar-dirty">*</span>}
        <span className="toolbar-sep">|</span>
        {fm.sourceId ? (
          <>
            <span
              className="toolbar-source"
              onClick={() => onSelectPost(fm.sourceId!)}
              title={`Source: ${fm.sourceId}`}
            >
              Source
            </span>
            <button className="btn-toolbar" onClick={() => setSourcePickerOpen(true)}>
              Change
            </button>
            <button className="btn-toolbar" onClick={handleClearSource}>
              Unlink
            </button>
          </>
        ) : (
          <button className="btn-toolbar" onClick={() => setSourcePickerOpen(true)}>
            Link Source
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn-toolbar" onClick={handleCopyContent}>
          {copiedKey === "content" ? "✓ Copied" : "Copy"}
        </button>
        <button className="btn-toolbar" onClick={onExport}>
          Export
        </button>
        <button className="btn-toolbar btn-delete" onClick={() => setDeleteConfirmOpen(true)}>
          Delete
        </button>
      </div>
      {statusError && (
        <div className="toolbar-error">{statusError}</div>
      )}
      <div className="center-editor">
        <MarkdownEditor
          ref={editorRef}
          content={content}
          onContentChange={handleContentChange}
          onSave={save}
          watermark={watermark}
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
          message="Delete this post? This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={handleDelete}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
    </div>
  );
});
