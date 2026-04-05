import { useCallback, useEffect, useState } from "react";
import { LeftPane } from "./components/LeftPane";
import { CenterPane } from "./components/CenterPane";
import { RightPane } from "./components/RightPane";
import { ExportModal } from "./components/ExportModal";
import { NewPostModal } from "./components/NewPostModal";
import { SettingsModal } from "./components/SettingsModal";
import { fetchPosts, createPost, fetchTargets, fetchSettings } from "./api";
import type { Post, PostSummary, Target } from "./types";
import "./App.css";

const BATCH_SIZE = 50;
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

  const loadPosts = useCallback(
    async (pubOffset = 0, append = false) => {
      const data = await fetchPosts(pubOffset, BATCH_SIZE);
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
        if (s.editorWatermark) setWatermark(s.editorWatermark);
        if (s.extraFieldWatermark) setExtraFieldWatermark(s.extraFieldWatermark);
      })
      .catch(() => {});
  }, [loadPosts]);

  const reloadConfig = () => {
    fetchTargets().then(setTargets).catch(() => {});
    fetchSettings()
      .then((s) => {
        if (s.editorWatermark) setWatermark(s.editorWatermark);
        if (s.extraFieldWatermark) setExtraFieldWatermark(s.extraFieldWatermark);
      })
      .catch(() => {});
  };

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
