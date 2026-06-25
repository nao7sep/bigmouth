import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { CSSProperties, MouseEventHandler, RefObject } from "react";
import { fetchPosts, createPost, fetchTargets, fetchSettings, revealCurrentLogFile } from "./api";
import { LeftPane } from "./components/LeftPane";
import { CenterPane, type CenterPaneHandle } from "./components/CenterPane";
import { RightPane, type RightPaneHandle, type RightTab } from "./components/RightPane";
import type { MarkdownEditorHandle } from "./components/MarkdownEditor";
import { ExportModal } from "./components/ExportModal";
import { NewPostModal } from "./components/NewPostModal";
import { SettingsModal } from "./components/SettingsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { AboutModal } from "./components/AboutModal";
import type { Post, PostMutationResult, PostSummary, Settings, Target, Workspace } from "@shared/types";
import { useAnyModalOpen } from "./hooks/useModalStack";
import { isComposingEvent } from "./hooks/useComposing";
import { pickAdjacentPostId } from "./util/selection";
import { applyPostMutationToBuckets } from "./util/postBuckets";

const DEFAULT_WATERMARK =
  "Consider starting with an outline:\n- Who is this for?\n- What should they take away?\n- What are the key points?";

interface WorkspaceSessionProps {
  workspace: Workspace;
  // The pane row, surfaced to the parent so its splitter clamp can measure the
  // live container width.
  appLayoutRef: RefObject<HTMLDivElement | null>;
  leftWidth: number;
  rightWidth: number;
  onStartLeftDrag: MouseEventHandler<HTMLDivElement>;
  onStartRightDrag: MouseEventHandler<HTMLDivElement>;
  onSwitchWorkspace: () => void;
}

export interface WorkspaceSessionHandle {
  flushPendingChanges: () => Promise<boolean>;
}

export const WorkspaceSession = forwardRef<WorkspaceSessionHandle, WorkspaceSessionProps>(
  function WorkspaceSession(
    {
      workspace,
      appLayoutRef,
      leftWidth,
      rightWidth,
      onStartLeftDrag,
      onStartRightDrag,
      onSwitchWorkspace,
    },
    ref
  ) {
    const anyModalOpen = useAnyModalOpen();
    const [drafts, setDrafts] = useState<PostSummary[]>([]);
    const [ready, setReady] = useState<PostSummary[]>([]);
    const [published, setPublished] = useState<PostSummary[]>([]);
    const [publishedTotal, setPublishedTotal] = useState(0);
    const [publishedOffset, setPublishedOffset] = useState(0);
    const [expired, setExpired] = useState<PostSummary[]>([]);
    const [expiredTotal, setExpiredTotal] = useState(0);
    const [expiredOffset, setExpiredOffset] = useState(0);
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
    const [loadError, setLoadError] = useState<string | null>(null);
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
    const expiredRef = useRef<PostSummary[]>([]);
    const expiredTotalRef = useRef(0);

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

    useEffect(() => {
      expiredRef.current = expired;
    }, [expired]);

    useEffect(() => {
      expiredTotalRef.current = expiredTotal;
    }, [expiredTotal]);

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

    // Published and Expired are independently paginated archives. One fetch
    // returns a page of each, so `append` names which archive is growing: on a
    // "load more" we append that archive's page and leave the other archive's
    // pagination untouched (its first page in the same response is ignored).
    // Drafts and ready are fully loaded, so they are always replaced.
    const loadPosts = useCallback(
      async (opts?: {
        publishedOffset?: number;
        expiredOffset?: number;
        append?: "published" | "expired";
      }) => {
        if (!sessionAliveRef.current) return;
        const pubOffset = opts?.publishedOffset ?? 0;
        const expOffset = opts?.expiredOffset ?? 0;
        const data = await fetchPosts(pubOffset, pubBatchSize, expOffset);
        if (!sessionAliveRef.current) return;

        draftsRef.current = data.drafts;
        readyRef.current = data.ready;
        setDrafts(data.drafts);
        setReady(data.ready);

        if (opts?.append !== "expired") {
          const nextPublished =
            opts?.append === "published"
              ? [...publishedRef.current, ...data.published]
              : data.published;
          publishedRef.current = nextPublished;
          setPublished(nextPublished);
          publishedTotalRef.current = data.publishedTotal;
          setPublishedTotal(data.publishedTotal);
          setPublishedOffset(pubOffset + data.published.length);
        }

        if (opts?.append !== "published") {
          const nextExpired =
            opts?.append === "expired"
              ? [...expiredRef.current, ...data.expired]
              : data.expired;
          expiredRef.current = nextExpired;
          setExpired(nextExpired);
          expiredTotalRef.current = data.expiredTotal;
          setExpiredTotal(data.expiredTotal);
          setExpiredOffset(expOffset + data.expired.length);
        }
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

    const loadConfig = useCallback(async () => {
      const [nextTargets, settings] = await Promise.all([fetchTargets(), fetchSettings()]);
      if (!sessionAliveRef.current) return;
      setTargets(nextTargets);
      applySettings(settings);
    }, [applySettings]);

    useEffect(() => {
      let cancelled = false;
      setLoadError(null);
      // Surface load failures instead of swallowing them: a failed targets load
      // would otherwise leave the New Post dialog silently empty.
      Promise.all([loadPosts(), loadConfig()]).catch((err) => {
        if (cancelled || !sessionAliveRef.current) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load this workspace.");
      });
      return () => {
        cancelled = true;
      };
    }, [loadConfig, loadPosts]);

    const reloadConfig = useCallback(() => {
      if (!sessionAliveRef.current) return;
      setLoadError(null);
      loadConfig().catch((err) => {
        if (!sessionAliveRef.current) return;
        setLoadError(err instanceof Error ? err.message : "Failed to reload settings.");
      });
      setAnalysisPromptsVersion((n) => n + 1);
    }, [loadConfig]);

    useEffect(() => {
      // Any open modal/dialog owns the keyboard; global shortcuts must not
      // mutate state behind it. The modal stack is the single source of truth
      // here, so this also covers confirms opened deep in the pane tree, not
      // just the top-level session modals.
      if (anyModalOpen) return;

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

        // While an IME candidate is pending, the chord belongs to the composition — even Cmd+N,
        // which otherwise fires inside an input, stands down until it commits (text-input-ime).
        if (isComposingEvent(e)) return;

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
    }, [anyModalOpen]);

    const handleCreatePost = async (target: string, language: string, sourceId?: string) => {
      const post = await createPost(target, language, sourceId);
      if (!sessionAliveRef.current) return;
      setNewPostOpen(false);
      await loadPosts();
      await selectPost(post.frontMatter.id);
    };

    const handlePostDeleted = useCallback(() => {
      if (!sessionAliveRef.current) return;
      const deletedId = selectedPostIdRef.current;
      // Drop only the deleted post from the back stack (it can't be navigated to
      // anymore), keeping the rest so Back still works through the other posts.
      setNavHistory((history) => history.filter((id) => id !== deletedId));

      // Delete always targets the open post, so it lives in exactly one loaded
      // section. Drop it from that section and move the selection to its
      // neighbour, keeping the user in place. (Drafts and ready are fully
      // loaded; only a published post reached via a source link could be
      // missing from the loaded page — fall back to a reload then.)
      const removeFrom = (list: PostSummary[]) =>
        list.filter((entry) => entry.frontMatter.id !== deletedId);

      if (deletedId && draftsRef.current.some((p) => p.frontMatter.id === deletedId)) {
        const nextId = pickAdjacentPostId(draftsRef.current, deletedId);
        const next = removeFrom(draftsRef.current);
        draftsRef.current = next;
        setDrafts(next);
        void selectPost(nextId, { skipFlush: true });
        return;
      }
      if (deletedId && readyRef.current.some((p) => p.frontMatter.id === deletedId)) {
        const nextId = pickAdjacentPostId(readyRef.current, deletedId);
        const next = removeFrom(readyRef.current);
        readyRef.current = next;
        setReady(next);
        void selectPost(nextId, { skipFlush: true });
        return;
      }
      if (deletedId && publishedRef.current.some((p) => p.frontMatter.id === deletedId)) {
        const nextId = pickAdjacentPostId(publishedRef.current, deletedId);
        const next = removeFrom(publishedRef.current);
        publishedRef.current = next;
        setPublished(next);
        const nextTotal = Math.max(0, publishedTotalRef.current - 1);
        publishedTotalRef.current = nextTotal;
        setPublishedTotal(nextTotal);
        setPublishedOffset(next.length);
        void selectPost(nextId, { skipFlush: true });
        return;
      }
      if (deletedId && expiredRef.current.some((p) => p.frontMatter.id === deletedId)) {
        const nextId = pickAdjacentPostId(expiredRef.current, deletedId);
        const next = removeFrom(expiredRef.current);
        expiredRef.current = next;
        setExpired(next);
        const nextTotal = Math.max(0, expiredTotalRef.current - 1);
        expiredTotalRef.current = nextTotal;
        setExpiredTotal(nextTotal);
        setExpiredOffset(next.length);
        void selectPost(nextId, { skipFlush: true });
        return;
      }

      // Not in any loaded section (rare): clear and reload to resync.
      void selectPost(null, { skipFlush: true });
      loadPosts().catch((err) => {
        if (!sessionAliveRef.current) return;
        setLoadError(err instanceof Error ? err.message : "Failed to refresh posts.");
      });
    }, [loadPosts, selectPost]);

    const handlePostUpdated = useCallback((result: PostMutationResult) => {
      if (!sessionAliveRef.current) return;

      // The server returns the canonical list summary (including its derived
      // excerpt); use it verbatim for the list and the full post for the editor.
      const summary: PostSummary = { frontMatter: result.summary };
      const id = result.frontMatter.id;
      // The open post is the only fallback for a post that isn't in any loaded
      // list (it was reached via a source link, so its bucket is off the page).
      const openPostStatus =
        currentPostRef.current?.frontMatter.id === id
          ? currentPostRef.current.frontMatter.status
          : null;

      const next = applyPostMutationToBuckets(
        {
          drafts: draftsRef.current,
          ready: readyRef.current,
          published: publishedRef.current,
          publishedTotal: publishedTotalRef.current,
          expired: expiredRef.current,
          expiredTotal: expiredTotalRef.current,
        },
        summary,
        result.frontMatter.status,
        openPostStatus
      );

      draftsRef.current = next.drafts;
      readyRef.current = next.ready;
      publishedRef.current = next.published;
      publishedTotalRef.current = next.publishedTotal;
      expiredRef.current = next.expired;
      expiredTotalRef.current = next.expiredTotal;
      setDrafts(next.drafts);
      setReady(next.ready);
      setPublished(next.published);
      setPublishedTotal(next.publishedTotal);
      setPublishedOffset(next.published.length);
      setExpired(next.expired);
      setExpiredTotal(next.expiredTotal);
      setExpiredOffset(next.expired.length);

      if (id === selectedPostIdRef.current) {
        setCurrentPost(result);
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
      setLoadError(null);
      loadPosts({ publishedOffset, append: "published" }).catch((err) => {
        if (!sessionAliveRef.current) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load more posts.");
      });
    }, [loadPosts, publishedOffset]);

    const handleLoadMoreExpired = useCallback(() => {
      setLoadError(null);
      loadPosts({ expiredOffset, append: "expired" }).catch((err) => {
        if (!sessionAliveRef.current) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load more posts.");
      });
    }, [loadPosts, expiredOffset]);

    const handleRevealCurrentLogFile = useCallback(async () => {
      try {
        setLoadError(null);
        await revealCurrentLogFile();
      } catch (err) {
        if (!sessionAliveRef.current) return;
        setLoadError(err instanceof Error ? err.message : "Failed to reveal current log file.");
      }
    }, []);

    const currentTarget =
      currentPost && currentPost.frontMatter.id === selectedPostId
        ? targets.find((target) => target.name === currentPost.frontMatter.target) ?? null
        : null;
    const postLoading =
      Boolean(selectedPostId) &&
      currentPost?.frontMatter.id !== selectedPostId;

    return (
      <div className="workspace-session">
        {loadError && (
          <div className="toolbar-error">
            <span>{loadError}</span>
            <button
              className="toolbar-error-dismiss"
              onClick={() => setLoadError(null)}
            >
              ×
            </button>
          </div>
        )}
        <div
          ref={appLayoutRef}
          className="app-layout"
          style={{ "--bm-left": `${leftWidth}px`, "--bm-right": `${rightWidth}px` } as CSSProperties}
        >
          <LeftPane
            drafts={drafts}
            ready={ready}
            published={published}
            publishedTotal={publishedTotal}
            expired={expired}
            expiredTotal={expiredTotal}
            selectedPostId={selectedPostId}
            onSelectPost={(id) => {
              void (async () => {
                const switched = await selectPost(id);
                if (switched) setNavHistory([]);
              })();
            }}
            onNewPost={() => setNewPostOpen(true)}
            onLoadMorePublished={handleLoadMorePublished}
            onLoadMoreExpired={handleLoadMoreExpired}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onOpenAbout={() => setAboutOpen(true)}
            onRevealCurrentLogFile={handleRevealCurrentLogFile}
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
      </div>
    );
  }
);
