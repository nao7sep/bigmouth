import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { CSSProperties, MouseEventHandler } from "react";
import { fetchPosts, createPost, fetchTargets, fetchSettings } from "./api";
import { LeftPane } from "./components/LeftPane";
import { CenterPane, type CenterPaneHandle } from "./components/CenterPane";
import { RightPane, type RightPaneHandle, type RightTab } from "./components/RightPane";
import type { MarkdownEditorHandle } from "./components/MarkdownEditor";
import { ExportModal } from "./components/ExportModal";
import { NewPostModal } from "./components/NewPostModal";
import { SettingsModal } from "./components/SettingsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { AboutModal } from "./components/AboutModal";
import type { Post, PostStatus, PostSummary, Settings, Target, Workspace } from "./types";

const DEFAULT_WATERMARK =
  "Consider starting with an outline:\n- Who is this for?\n- What should they take away?\n- What are the key points?";

interface WorkspaceSessionProps {
  workspace: Workspace;
  leftWidth: number;
  rightWidth: number;
  onStartLeftDrag: MouseEventHandler<HTMLDivElement>;
  onStartRightDrag: MouseEventHandler<HTMLDivElement>;
  onSwitchWorkspace: () => void;
  suspended?: boolean;
}

export interface WorkspaceSessionHandle {
  flushPendingChanges: () => Promise<boolean>;
}

export const WorkspaceSession = forwardRef<WorkspaceSessionHandle, WorkspaceSessionProps>(
  function WorkspaceSession(
    {
      workspace,
      leftWidth,
      rightWidth,
      onStartLeftDrag,
      onStartRightDrag,
      onSwitchWorkspace,
      suspended = false,
    },
    ref
  ) {
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
    const [rightTab, setRightTab] = useState<RightTab>("Analysis");
    const [analysisTrigger, setAnalysisTrigger] = useState(0);
    const [analysisPromptsVersion, setAnalysisPromptsVersion] = useState(0);
    const editorRef = useRef<MarkdownEditorHandle>(null);
    const centerPaneRef = useRef<CenterPaneHandle>(null);
    const rightPaneRef = useRef<RightPaneHandle>(null);
    const sessionAliveRef = useRef(true);
    const selectedPostIdRef = useRef<string | null>(null);
    const currentPostRef = useRef<Post | null>(null);
    const draftsRef = useRef<PostSummary[]>([]);
    const readyRef = useRef<PostSummary[]>([]);
    const publishedRef = useRef<PostSummary[]>([]);
    const publishedTotalRef = useRef(0);

    useEffect(() => {
      sessionAliveRef.current = true;
      return () => {
        sessionAliveRef.current = false;
      };
    }, []);

    useEffect(() => {
      selectedPostIdRef.current = selectedPostId;
    }, [selectedPostId]);

    useEffect(() => {
      currentPostRef.current = currentPost;
    }, [currentPost]);

    useEffect(() => {
      draftsRef.current = drafts;
    }, [drafts]);

    useEffect(() => {
      readyRef.current = ready;
    }, [ready]);

    useEffect(() => {
      publishedRef.current = published;
    }, [published]);

    useEffect(() => {
      publishedTotalRef.current = publishedTotal;
    }, [publishedTotal]);

    const flushRightPaneChanges = useCallback(
      async () => (await rightPaneRef.current?.flushPendingChanges()) ?? true,
      []
    );

    const flushPendingChanges = useCallback(async () => {
      const centerFlushed = (await centerPaneRef.current?.flushPendingChanges()) ?? true;
      const rightFlushed = (await flushRightPaneChanges()) ?? true;
      return centerFlushed && rightFlushed;
    }, [flushRightPaneChanges]);

    useImperativeHandle(
      ref,
      () => ({
        flushPendingChanges,
      }),
      [flushPendingChanges]
    );

    const selectPost = useCallback(
      async (id: string | null, options?: { skipFlush?: boolean }) => {
        if (id === selectedPostIdRef.current) return true;
        if (!options?.skipFlush) {
          const flushed = await flushPendingChanges();
          if (!flushed) return false;
        }
        setSelectedPostId(id);
        setCurrentPost(null);
        setEditorContent("");
        return true;
      },
      [flushPendingChanges]
    );

    const loadPosts = useCallback(
      async (pubOffset = 0, append = false) => {
        if (!sessionAliveRef.current) return;
        const data = await fetchPosts(pubOffset, pubBatchSize);
        if (!sessionAliveRef.current) return;
        draftsRef.current = data.drafts;
        readyRef.current = data.ready;
        setDrafts(data.drafts);
        setReady(data.ready);
        const nextPublished = append ? [...publishedRef.current, ...data.published] : data.published;
        publishedRef.current = nextPublished;
        setPublished(nextPublished);
        publishedTotalRef.current = data.publishedTotal;
        setPublishedTotal(data.publishedTotal);
        setPublishedOffset(pubOffset + data.published.length);
      },
      [pubBatchSize]
    );

    const applySettings = useCallback((settings: Settings) => {
      if (settings.publishedPostsPerLoad) setPubBatchSize(settings.publishedPostsPerLoad);
      if (settings.maxUploadMb) setMaxUploadMb(settings.maxUploadMb);
      setWatermark(settings.editorWatermark);
      setExtraFieldWatermark(settings.extraFieldWatermark);
      if (settings.supportedLanguages?.length) setSupportedLanguages(settings.supportedLanguages);
    }, []);

    useEffect(() => {
      let cancelled = false;
      void loadPosts();
      fetchTargets()
        .then((nextTargets) => {
          if (cancelled || !sessionAliveRef.current) return;
          setTargets(nextTargets);
        })
        .catch(() => {});
      fetchSettings()
        .then((settings) => {
          if (cancelled || !sessionAliveRef.current) return;
          applySettings(settings);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [applySettings, loadPosts]);

    const reloadConfig = useCallback(() => {
      if (!sessionAliveRef.current) return;
      fetchTargets()
        .then((nextTargets) => {
          if (!sessionAliveRef.current) return;
          setTargets(nextTargets);
        })
        .catch(() => {});
      fetchSettings()
        .then((settings) => {
          if (!sessionAliveRef.current) return;
          applySettings(settings);
        })
        .catch(() => {});
      setAnalysisPromptsVersion((n) => n + 1);
    }, [applySettings]);

    useEffect(() => {
      if (suspended) return;

      const TAB_KEYS: Record<string, RightTab> = {
        "1": "Analysis",
        "2": "Imaging",
        "3": "Assets",
        "4": "Preview",
        "5": "Metadata",
      };

      const handler = (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;

        const tag = (e.target as HTMLElement).tagName;
        if (tag === "TEXTAREA" || tag === "SELECT") return;
        if (tag === "INPUT" && e.key !== "n") return;

        if (e.key === "n") {
          e.preventDefault();
          setNewPostOpen(true);
          return;
        }
        if (e.key === "e" && selectedPostIdRef.current) {
          e.preventDefault();
          setExportOpen(true);
          return;
        }
        if (e.key === "Enter" && selectedPostIdRef.current) {
          e.preventDefault();
          setRightTab("Analysis");
          setAnalysisTrigger((n) => n + 1);
          return;
        }
        const tab = TAB_KEYS[e.key];
        if (tab && selectedPostIdRef.current) {
          e.preventDefault();
          setRightTab(tab);
        }
      };

      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, [suspended]);

    const handleCreatePost = async (target: string, language: string, sourceId?: string) => {
      const post = await createPost(target, language, sourceId);
      if (!sessionAliveRef.current) return;
      setNewPostOpen(false);
      await loadPosts();
      await selectPost(post.frontMatter.id);
    };

    const handlePostDeleted = useCallback(() => {
      void selectPost(null, { skipFlush: true });
      setNavHistory([]);
      void loadPosts();
    }, [loadPosts, selectPost]);

    const handlePostUpdated = useCallback((post: Post) => {
      if (!sessionAliveRef.current) return;

      const summary = { frontMatter: post.frontMatter };
      const id = post.frontMatter.id;
      const draftLoaded = draftsRef.current.some((entry) => entry.frontMatter.id === id);
      const readyLoaded = readyRef.current.some((entry) => entry.frontMatter.id === id);
      const publishedLoaded = publishedRef.current.some((entry) => entry.frontMatter.id === id);
      const previousStatus = draftLoaded
        ? "draft"
        : readyLoaded
          ? "ready"
          : publishedLoaded
            ? "published"
            : currentPostRef.current?.frontMatter.id === id
              ? currentPostRef.current.frontMatter.status
              : null;

      const nextDrafts = nextSummariesForStatus(
        draftsRef.current,
        summary,
        "draft",
        post.frontMatter.status === "draft"
      );
      const nextReady = nextSummariesForStatus(
        readyRef.current,
        summary,
        "ready",
        post.frontMatter.status === "ready"
      );
      const nextPublished = nextSummariesForStatus(
        publishedRef.current,
        summary,
        "published",
        post.frontMatter.status === "published" && (publishedLoaded || previousStatus !== "published")
      );

      let nextPublishedTotal = publishedTotalRef.current;
      if (previousStatus === "published" && post.frontMatter.status !== "published") {
        nextPublishedTotal = Math.max(0, nextPublishedTotal - 1);
      } else if (
        previousStatus !== null &&
        previousStatus !== "published" &&
        post.frontMatter.status === "published"
      ) {
        nextPublishedTotal += 1;
      }

      draftsRef.current = nextDrafts;
      readyRef.current = nextReady;
      publishedRef.current = nextPublished;
      publishedTotalRef.current = nextPublishedTotal;
      setDrafts(nextDrafts);
      setReady(nextReady);
      setPublished(nextPublished);
      setPublishedTotal(nextPublishedTotal);
      setPublishedOffset(nextPublished.length);

      if (post.frontMatter.id === selectedPostIdRef.current) {
        setCurrentPost(post);
      }
    }, []);

    const handleNavigateToPost = useCallback(
      async (id: string) => {
        const previousId = selectedPostIdRef.current;
        const switched = await selectPost(id);
        if (switched && previousId) {
          setNavHistory((history) => [...history, previousId]);
        }
      },
      [selectPost]
    );

    const handleGoBack = useCallback(async () => {
      const prev = navHistory[navHistory.length - 1];
      if (!prev) return;
      const switched = await selectPost(prev);
      if (switched) {
        setNavHistory((history) => history.slice(0, -1));
      }
    }, [navHistory, selectPost]);

    const handleLoadMorePublished = useCallback(() => {
      void loadPosts(publishedOffset, true);
    }, [loadPosts, publishedOffset]);

    const currentTarget =
      currentPost && currentPost.frontMatter.id === selectedPostId
        ? targets.find((target) => target.name === currentPost.frontMatter.target) ?? null
        : null;
    const postLoading =
      Boolean(selectedPostId) &&
      currentPost?.frontMatter.id !== selectedPostId;

    return (
      <div
        className="app-layout"
        style={{ "--bm-left": `${leftWidth}px`, "--bm-right": `${rightWidth}px` } as CSSProperties}
      >
        <LeftPane
          drafts={drafts}
          ready={ready}
          published={published}
          publishedTotal={publishedTotal}
          selectedPostId={selectedPostId}
          onSelectPost={(id) => {
            void (async () => {
              const switched = await selectPost(id);
              if (switched) setNavHistory([]);
            })();
          }}
          onNewPost={() => setNewPostOpen(true)}
          onLoadMorePublished={handleLoadMorePublished}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenAbout={() => setAboutOpen(true)}
          onSwitchWorkspace={onSwitchWorkspace}
          workspaceName={workspace.name}
        />
        <div className="pane-divider" onMouseDown={onStartLeftDrag} />
        {selectedPostId ? (
          <>
            <CenterPane
              ref={centerPaneRef}
              key={selectedPostId}
              workspaceId={workspace.id}
              postId={selectedPostId}
              onPostUpdated={handlePostUpdated}
              onPostDeleted={handlePostDeleted}
              onContentChange={setEditorContent}
              onPostLoaded={setCurrentPost}
              onExport={() => setExportOpen(true)}
              onSelectPost={handleNavigateToPost}
              onGoBack={navHistory.length > 0 ? handleGoBack : undefined}
              onBeforeStatusChange={flushRightPaneChanges}
              pubBatchSize={pubBatchSize}
              watermark={watermark}
              editorRef={editorRef}
            />
            <div className="pane-divider" onMouseDown={onStartRightDrag} />
            <RightPane
              ref={rightPaneRef}
              workspaceId={workspace.id}
              content={editorContent}
              postId={selectedPostId}
              frontMatter={
                currentPost?.frontMatter.id === selectedPostId ? currentPost.frontMatter : null
              }
              target={currentTarget}
              extraFieldWatermark={extraFieldWatermark}
              onPostUpdated={handlePostUpdated}
              activeTab={rightTab}
              onTabChange={setRightTab}
              analysisTrigger={analysisTrigger}
              analysisPromptsVersion={analysisPromptsVersion}
              onInsertAtCursor={(text) => editorRef.current?.insertAtCursor(text)}
              maxUploadMb={maxUploadMb}
              loading={postLoading}
            />
          </>
        ) : (
          <div className="pane-empty">Select a post or create a new one</div>
        )}
        {settingsOpen && (
          <SettingsModal onClose={() => setSettingsOpen(false)} onSettingsChanged={reloadConfig} />
        )}
        {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
        {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}
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
);

function nextSummariesForStatus(
  current: PostSummary[],
  summary: PostSummary,
  status: PostStatus,
  include: boolean
): PostSummary[] {
  const filtered = current.filter((entry) => entry.frontMatter.id !== summary.frontMatter.id);
  if (!include) return filtered;

  return [...filtered, summary].sort((a, b) => compareSummaries(status, a, b));
}

function compareSummaries(status: PostStatus, a: PostSummary, b: PostSummary): number {
  if (status === "published") {
    const aTime = a.frontMatter.publishedAtUtc ?? "";
    const bTime = b.frontMatter.publishedAtUtc ?? "";
    return (
      bTime.localeCompare(aTime) ||
      (b.frontMatter.slug ?? "").localeCompare(a.frontMatter.slug ?? "")
    );
  }

  const aTime = a.frontMatter.updatedAtUtc ?? a.frontMatter.createdAtUtc ?? "";
  const bTime = b.frontMatter.updatedAtUtc ?? b.frontMatter.createdAtUtc ?? "";
  return bTime.localeCompare(aTime);
}
