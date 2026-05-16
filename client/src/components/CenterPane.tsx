import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Post, PostStatus } from "../types";
import { fetchPost, updatePost, changePostStatus, deletePost } from "../api";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SourcePickerModal } from "./SourcePickerModal";
import { ConfirmModal } from "./ConfirmModal";
import { computeCounts, type ContentCounts } from "../util/counts";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

interface CenterPaneProps {
  workspaceId: string;
  postId: string;
  onPostUpdated: (post: Post) => void;
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

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (contentRef.current !== savedContentRef.current) {
        void updatePost(postId, { content: contentRef.current }, workspaceId)
          .then((updated) => onPostUpdatedRef.current(updated))
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleContentChange = (value: string) => {
    setContent(value);
    contentRef.current = value;
    notifyContentChange(value);
    setStatusError(null);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void save(), AUTO_SAVE_DELAY);
  };

  const handleStatusChange = async (newStatus: PostStatus) => {
    if (!post || post.frontMatter.status === newStatus) return;

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
        <select
          className="toolbar-status"
          value={fm.status}
          onChange={(e) => void handleStatusChange(e.target.value as PostStatus)}
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
              onClick={() => void onSelectPost(fm.sourceId!)}
              title={`Source: ${fm.sourceId}`}
            >
              Source
            </span>
            <button className="btn-toolbar" onClick={() => setSourcePickerOpen(true)}>
              Change
            </button>
            <button className="btn-toolbar" onClick={() => void handleClearSource()}>
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
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
    </div>
  );
});
