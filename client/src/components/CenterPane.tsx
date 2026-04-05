import { useCallback, useEffect, useRef, useState } from "react";
import type { Post } from "../types";
import { fetchPost, updatePost } from "../api";

interface CenterPaneProps {
  postId: string;
  onPostSaved: () => void;
  watermark: string;
}

const AUTO_SAVE_DELAY = 2000;

export function CenterPane({ postId, onPostSaved, watermark }: CenterPaneProps) {
  const [post, setPost] = useState<Post | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
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

  // Load post when postId changes (save current first)
  useEffect(() => {
    let cancelled = false;

    const loadPost = async () => {
      const loaded = await fetchPost(postId);
      if (cancelled) return;
      setPost(loaded);
      setContent(loaded.content);
      setDirty(false);
    };

    // Save previous post if dirty, then load new one
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
    setDirty(true);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      save();
    }, AUTO_SAVE_DELAY);
  };

  // Cmd+S / Ctrl+S immediate save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [save]);

  // Save on unmount
  useEffect(() => {
    return () => {
      if (dirtyRef.current) {
        // Fire-and-forget save
        updatePost(postIdRef.current, { content: contentRef.current }).catch(
          () => {}
        );
      }
    };
  }, []);

  if (!post) return null;

  const fm = post.frontMatter;
  const charCount = content.length;
  const paragraphs = content
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 0);
  const paragraphCount = paragraphs.length;

  return (
    <div className="pane-center">
      <div className="center-toolbar">
        <span>{fm.target}</span>
        <span>|</span>
        <span>{fm.language}</span>
        <span>|</span>
        <span>
          {fm.status}
          {dirty && " *"}
        </span>
      </div>
      <div className="center-editor">
        <textarea
          value={content}
          onChange={(e) => handleContentChange(e.target.value)}
          placeholder={watermark}
          spellCheck
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            outline: "none",
            resize: "none",
            fontFamily: "inherit",
            fontSize: 14,
            lineHeight: 1.6,
          }}
        />
      </div>
      <div className="center-counts">
        <span>{charCount} characters</span>
        <span>{paragraphCount} paragraphs</span>
      </div>
    </div>
  );
}
