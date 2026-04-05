import { useCallback, useEffect, useState } from "react";
import { LeftPane } from "./components/LeftPane";
import { CenterPane } from "./components/CenterPane";
import { RightPane } from "./components/RightPane";
import { fetchPosts, createPost, fetchTargets, fetchSettings } from "./api";
import type { PostSummary, Target } from "./types";
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
      })
      .catch(() => {});
  }, [loadPosts]);

  const handleNewPost = async () => {
    const target = targets.length > 0 ? targets[0].name : "default";
    const language =
      targets.length > 0 ? targets[0].defaultLanguage : "en";

    const post = await createPost(target, language);
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
      />
      {selectedPostId ? (
        <>
          <CenterPane
            postId={selectedPostId}
            onPostSaved={loadPosts}
            onPostDeleted={handlePostDeleted}
            watermark={watermark}
          />
          <RightPane />
        </>
      ) : (
        <div className="pane-empty">Select a post or create a new one</div>
      )}
    </div>
  );
}
