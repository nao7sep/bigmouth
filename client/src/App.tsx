import { useCallback, useEffect, useRef, useState } from "react";
import { LeftPane } from "./components/LeftPane";
import { CenterPane } from "./components/CenterPane";
import { RightPane, type RightTab } from "./components/RightPane";
import type { MarkdownEditorHandle } from "./components/MarkdownEditor";
import { ExportModal } from "./components/ExportModal";
import { NewPostModal } from "./components/NewPostModal";
import { SettingsModal } from "./components/SettingsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { AboutModal } from "./components/AboutModal";
import { fetchPosts, createPost, fetchTargets, fetchSettings } from "./api";
import type { Post, PostSummary, Settings, Target } from "./types";
import "./App.css";

const DEFAULT_WATERMARK =
  "Consider starting with an outline:\n- Who is this for?\n- What should they take away?\n- What are the key points?";

const STORAGE_LEFT  = "bm-pane-left-width";
const STORAGE_RIGHT = "bm-pane-right-width";

function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

function readStoredWidth(key: string, fallback: number, min: number, max: number) {
  const v = localStorage.getItem(key);
  return v ? clamp(+v, min, max) : fallback;
}

export function App() {
  const [drafts, setDrafts] = useState<PostSummary[]>([]);
  const [ready, setReady] = useState<PostSummary[]>([]);
  const [published, setPublished] = useState<PostSummary[]>([]);
  const [publishedTotal, setPublishedTotal] = useState(0);
  const [publishedOffset, setPublishedOffset] = useState(0);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [navHistory, setNavHistory] = useState<string[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [supportedLanguages, setSupportedLanguages] = useState<string[]>(["en"]);
  const [pubBatchSize, setPubBatchSize] = useState(50);
  const [maxUploadMb, setMaxUploadMb] = useState(500);
  const [watermark, setWatermark] = useState(DEFAULT_WATERMARK);
  const [extraFieldWatermark, setExtraFieldWatermark] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [currentPost, setCurrentPost] = useState<Post | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [newPostOpen, setNewPostOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("AI Analysis");
  const [analysisTrigger, setAnalysisTrigger] = useState(0);
  const editorRef = useRef<MarkdownEditorHandle>(null);

  // Resizable pane widths
  const [leftWidth,  setLeftWidth]  = useState(() => readStoredWidth(STORAGE_LEFT,  360, 240, 720));
  const [rightWidth, setRightWidth] = useState(() => readStoredWidth(STORAGE_RIGHT, 480, 320, 960));
  const leftWidthRef  = useRef(leftWidth);
  const rightWidthRef = useRef(rightWidth);
  leftWidthRef.current  = leftWidth;
  rightWidthRef.current = rightWidth;

  const startDrag = useCallback((
    e: React.MouseEvent,
    widthRef: React.MutableRefObject<number>,
    setWidth: (w: number) => void,
    storageKey: string,
    sign: 1 | -1,
    min: number,
    max: number,
  ) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      setWidth(clamp(startW + sign * (ev.clientX - startX), min, max));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(storageKey, String(widthRef.current));
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Clear stale post data whenever the selected post changes, regardless of how it changed
  useEffect(() => {
    setCurrentPost(null);
    setEditorContent("");
  }, [selectedPostId]);

  const loadPosts = useCallback(
    async (pubOffset = 0, append = false) => {
      const data = await fetchPosts(pubOffset, pubBatchSize);
      setDrafts(data.drafts);
      setReady(data.ready);
      setPublished((prev) =>
        append ? [...prev, ...data.published] : data.published
      );
      setPublishedTotal(data.publishedTotal);
      setPublishedOffset(pubOffset + data.published.length);
    },
    [pubBatchSize]
  );

  const applySettings = useCallback((s: Settings) => {
    if (s.publishedPostsPerLoad) setPubBatchSize(s.publishedPostsPerLoad);
    if (s.maxUploadMb) setMaxUploadMb(s.maxUploadMb);
    if (s.editorWatermark) setWatermark(s.editorWatermark);
    if (s.extraFieldWatermark) setExtraFieldWatermark(s.extraFieldWatermark);
    if (s.supportedLanguages?.length) setSupportedLanguages(s.supportedLanguages);
  }, []);

  useEffect(() => { loadPosts(); }, [loadPosts]);

  useEffect(() => {
    fetchTargets().then(setTargets).catch(() => {});
    fetchSettings().then(applySettings).catch(() => {});
  }, [applySettings]);

  const reloadConfig = useCallback(() => {
    fetchTargets().then(setTargets).catch(() => {});
    fetchSettings().then(applySettings).catch(() => {});
  }, [applySettings]);

  // Global keyboard shortcuts
  useEffect(() => {
    const TAB_KEYS: Record<string, RightTab> = {
      "1": "AI Analysis",
      "2": "Assets",
      "3": "Preview",
      "4": "Metadata",
    };

    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Don't intercept shortcuts when focus is inside an input, textarea, or select
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA" || tag === "SELECT") return;
      if (tag === "INPUT" && e.key !== "n") return;

      if (e.key === "n") {
        e.preventDefault();
        setNewPostOpen(true);
        return;
      }
      if (e.key === "e" && selectedPostId) {
        e.preventDefault();
        setExportOpen(true);
        return;
      }
      if (e.key === "Enter" && selectedPostId) {
        e.preventDefault();
        setRightTab("AI Analysis");
        setAnalysisTrigger((n) => n + 1);
        return;
      }
      const tab = TAB_KEYS[e.key];
      if (tab && selectedPostId) {
        e.preventDefault();
        setRightTab(tab);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedPostId]);

  const handleNewPost = () => {
    setNewPostOpen(true);
  };

  const handleCreatePost = async (
    target: string,
    language: string,
    sourceId?: string
  ) => {
    const post = await createPost(target, language, sourceId);
    setNewPostOpen(false);
    setSelectedPostId(post.frontMatter.id);
    await loadPosts();
  };

  const handlePostDeleted = () => {
    setSelectedPostId(null);
    setNavHistory([]);
    loadPosts();
  };

  const handleNavigateToPost = (id: string) => {
    if (selectedPostId) setNavHistory((h) => [...h, selectedPostId]);
    setSelectedPostId(id);
  };

  const handleGoBack = () => {
    setNavHistory((h) => {
      const prev = h[h.length - 1];
      if (prev) setSelectedPostId(prev);
      return h.slice(0, -1);
    });
  };

  const handleLoadMorePublished = () => {
    loadPosts(publishedOffset, true);
  };

  return (
    <div
      className="app-layout"
      style={{ "--bm-left": `${leftWidth}px`, "--bm-right": `${rightWidth}px` } as React.CSSProperties}
    >
      <LeftPane
        drafts={drafts}
        ready={ready}
        published={published}
        publishedTotal={publishedTotal}
        selectedPostId={selectedPostId}
        onSelectPost={(id) => { setNavHistory([]); setSelectedPostId(id); }}
        onNewPost={handleNewPost}
        onLoadMorePublished={handleLoadMorePublished}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
      />
      <div
        className="pane-divider"
        onMouseDown={(e) => startDrag(e, leftWidthRef, setLeftWidth, STORAGE_LEFT, 1, 240, 720)}
      />
      {selectedPostId ? (
        <>
          <CenterPane
            key={selectedPostId}
            postId={selectedPostId}
            onPostSaved={loadPosts}
            onPostDeleted={handlePostDeleted}
            onContentChange={setEditorContent}
            onPostLoaded={setCurrentPost}
            onExport={() => setExportOpen(true)}
            onSelectPost={handleNavigateToPost}
            onGoBack={navHistory.length > 0 ? handleGoBack : undefined}
            pubBatchSize={pubBatchSize}
            watermark={watermark}
            editorRef={editorRef}
          />
          <div
            className="pane-divider"
            onMouseDown={(e) => startDrag(e, rightWidthRef, setRightWidth, STORAGE_RIGHT, -1, 320, 960)}
          />
          <RightPane
            content={editorContent}
            postId={selectedPostId}
            frontMatter={currentPost?.frontMatter ?? null}
            target={
              currentPost
                ? targets.find(
                    (t) => t.name === currentPost.frontMatter.target
                  ) ?? null
                : null
            }
            extraFieldWatermark={extraFieldWatermark}
            onMetadataSaved={loadPosts}
            onFrontMatterUpdated={setCurrentPost}
            activeTab={rightTab}
            onTabChange={setRightTab}
            analysisTrigger={analysisTrigger}
            onInsertAtCursor={(text) => editorRef.current?.insertAtCursor(text)}
            maxUploadMb={maxUploadMb}
          />
        </>
      ) : (
        <div className="pane-empty">Select a post or create a new one</div>
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          onSettingsChanged={reloadConfig}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsModal onClose={() => setShortcutsOpen(false)} />
      )}
      {aboutOpen && (
        <AboutModal onClose={() => setAboutOpen(false)} />
      )}
      {newPostOpen && (
        <NewPostModal
          targets={targets}
          supportedLanguages={supportedLanguages}
          pubBatchSize={pubBatchSize}
          onClose={() => setNewPostOpen(false)}
          onCreate={handleCreatePost}
        />
      )}
      {exportOpen && selectedPostId && (
        <ExportModal
          content={editorContent}
          slug={currentPost?.frontMatter.slug ?? selectedPostId}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}
