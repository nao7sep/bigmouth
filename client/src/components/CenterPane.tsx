import { useCallback, useEffect, useRef, useState } from "react";
import type { Post, PostStatus } from "../types";
import { fetchPost, updatePost, changePostStatus, deletePost } from "../api";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SourcePickerModal } from "./SourcePickerModal";
import { ConfirmModal } from "./ConfirmModal";
import { computeCounts, type ContentCounts } from "../util/counts";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

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

const AUTO_SAVE_DELAY = 2_000;

export function CenterPane({
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
}: CenterPaneProps) {
  const [post, setPost] = useState<Post | null>(null);
  const [content, setContent] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const { copiedKey, copy: copyContent } = useCopyFeedback();
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef("");
  const savedContentRef = useRef(""); // content as of last successful save
  const savingRef = useRef(false); // true while a save request is in-flight
  const pendingSaveRef = useRef(false); // true when another save should run afterward
  const savePromiseRef = useRef<Promise<void> | null>(null);

  const save = useCallback((): Promise<void> => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
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

          savingRef.current = true;
          try {
            const updated = await updatePost(postId, { content: current });
            savedContentRef.current = current;
            setPost(updated);
            onPostSaved();
          } catch {
            // Save failed silently — will retry on next change
            break;
          } finally {
            savingRef.current = false;
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
  }, [postId, onPostSaved]);

  const flushPendingContent = useCallback(async () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (contentRef.current !== savedContentRef.current) {
      await save();
    } else if (savePromiseRef.current) {
      await savePromiseRef.current;
    }
    return contentRef.current === savedContentRef.current;
  }, [save]);

  // Load post once on mount (key={postId} in App guarantees fresh instance per post)
  useEffect(() => {
    let cancelled = false;
    fetchPost(postId).then((loaded) => {
      if (cancelled) return;
      setPost(loaded);
      setContent(loaded.content);
      contentRef.current = loaded.content;
      savedContentRef.current = loaded.content;
      notifyContentChange(loaded.content);
      onPostLoaded(loaded);
      setStatusError(null);
    }).catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flush any pending save on unmount (safety net for fast post switches)
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (contentRef.current !== savedContentRef.current) {
        updatePost(postId, { content: contentRef.current }).catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleContentChange = (value: string) => {
    setContent(value);
    contentRef.current = value;
    notifyContentChange(value);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(save, AUTO_SAVE_DELAY);
  };

  const handleStatusChange = async (newStatus: PostStatus) => {
    if (!post || post.frontMatter.status === newStatus) return;
    try {
      setStatusError(null);
      const flushed = await flushPendingContent();
      if (!flushed) {
        setStatusError("Save failed. Try again before changing status.");
        return;
      }
      const updated = await changePostStatus(postId, newStatus);
      setPost(updated);
      onPostLoaded(updated);
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
            ◀ Back
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
        <div className="toolbar-error">
          {statusError}
          <button className="toolbar-error-dismiss" onClick={() => setStatusError(null)}>×</button>
        </div>
      )}
      <div className="center-editor">
        <MarkdownEditor
          ref={editorRef}
          content={content}
          onContentChange={handleContentChange}
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
}
