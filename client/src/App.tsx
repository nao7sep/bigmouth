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
import type { Post, PostSummary, Target } from "./types";
import "./App.css";

const DEFAULT_WATERMARK =
  "Consider starting with an outline:\n- Who is this for?\n- What should they take away?\n- What are the key points?";

export function App() {
  const [drafts, setDrafts] = useState<PostSummary[]>([]);
  const [ready, setReady] = useState<PostSummary[]>([]);
  const [published, setPublished] = useState<PostSummary[]>([]);
  const [publishedTotal, setPublishedTotal] = useState(0);
  const [publishedOffset, setPublishedOffset] = useState(0);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
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

  const batchSizeRef = useRef(50);

  const loadPosts = useCallback(
    async (pubOffset = 0, append = false) => {
      const data = await fetchPosts(pubOffset, batchSizeRef.current);
      setDrafts(data.drafts);
      setReady(data.ready);
      setPublished((prev) =>
        append ? [...prev, ...data.published] : data.published
      );
      setPublishedTotal(data.publishedTotal);
      setPublishedOffset(pubOffset + data.published.length);
    },
    []
  );

  useEffect(() => {
    loadPosts();
    fetchTargets().then(setTargets).catch(() => {});
    fetchSettings()
      .then((s) => {
        if (s.itemsPerPage) batchSizeRef.current = s.itemsPerPage;
        if (s.editorWatermark) setWatermark(s.editorWatermark);
        if (s.extraFieldWatermark) setExtraFieldWatermark(s.extraFieldWatermark);
      })
      .catch(() => {});
  }, [loadPosts]);

  const reloadConfig = () => {
    fetchTargets().then(setTargets).catch(() => {});
    fetchSettings()
      .then((s) => {
        if (s.itemsPerPage) batchSizeRef.current = s.itemsPerPage;
        if (s.editorWatermark) setWatermark(s.editorWatermark);
        if (s.extraFieldWatermark) setExtraFieldWatermark(s.extraFieldWatermark);
      })
      .catch(() => {});
  };

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
      if (tag === "INPUT" && e.key !== "n" && e.key !== "e") return;

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
    loadPosts();
  };

  const handleLoadMorePublished = () => {
    loadPosts(publishedOffset, true);
  };

  return (
    <div className="app-layout">
      <LeftPane
        drafts={drafts}
        ready={ready}
        published={published}
        publishedTotal={publishedTotal}
        selectedPostId={selectedPostId}
        onSelectPost={setSelectedPostId}
        onNewPost={handleNewPost}
        onLoadMorePublished={handleLoadMorePublished}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
      />
      {selectedPostId ? (
        <>
          <CenterPane
            postId={selectedPostId}
            onPostSaved={loadPosts}
            onPostDeleted={handlePostDeleted}
            onContentChange={setEditorContent}
            onPostLoaded={setCurrentPost}
            onExport={() => setExportOpen(true)}
            onSelectPost={setSelectedPostId}
            watermark={watermark}
            editorRef={editorRef}
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
            activeTab={rightTab}
            onTabChange={setRightTab}
            analysisTrigger={analysisTrigger}
            onInsertAtCursor={(text) => editorRef.current?.insertAtCursor(text)}
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
          allPosts={[...drafts, ...ready, ...published]}
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
