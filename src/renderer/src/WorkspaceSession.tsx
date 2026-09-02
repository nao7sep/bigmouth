import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { CSSProperties, MouseEventHandler, RefObject } from "react";
import {
  listPosts,
  createPost,
  getPost,
  listTargets,
  getSettings,
  revealCurrentLogFile,
  onPostContentSaved,
} from "./api";
import { presentFailure } from "./util/presentFailure";
import { LeftPane } from "./components/LeftPane";
import { OperationalResult } from "./components/OperationalResult";
import { CenterPane } from "./components/CenterPane";
import { RightPane, type RightPaneHandle, type RightTab } from "./components/RightPane";
import type { MarkdownEditorHandle } from "./components/MarkdownEditor";
import { ExportModal } from "./components/ExportModal";
import { NewPostModal } from "./components/NewPostModal";
import { SettingsModal } from "./components/SettingsModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { AboutModal } from "./components/AboutModal";
import type {
  ContentFont,
  Post,
  PostMutationResult,
  PostStatus,
  PostSummary,
  Settings,
  Target,
  Workspace,
} from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { useAnyModalOpen } from "./hooks/useModalStack";
import { isComposingEvent } from "./hooks/useComposing";
import { hasMod, isEditableTarget, shadowsMacTextBinding } from "./util/shortcuts";
import { pickAdjacentPostId } from "./util/selection";
import { applyPostMutationToBuckets } from "./util/postBuckets";
import { isValidTimeZone } from "./util/timestamps";

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
    const [contentFont, setContentFont] = useState<ContentFont>(DEFAULT_CONTENT_FONT);
    const [uiFontFamily, setUiFontFamily] = useState("");
    const [timezone, setTimezone] = useState("Asia/Tokyo");
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
    const rightPaneRef = useRef<RightPaneHandle>(null);
    /**
     * Mirrors of state that callbacks registered once — the global key handler,
     * an in-flight load — have to read at their own moment rather than at the
     * render that created them.
     *
     * Two kinds, and the difference decides where each is written:
     *
     *   - read only LATER (selectedPostId, currentPost, metadataTab): assigned
     *     during render, below. Always current by the time any event fires.
     *   - read back in the SAME tick as their setter (the list refs, which an
     *     append or an optimistic bucket update reads before React re-renders):
     *     assigned at each mutation site, eagerly.
     *
     * Every one of them used to carry BOTH — a post-render effect that copied
     * state into the ref, plus a hand assignment at each mutation site because
     * that copy lands too late. Two mechanisms maintaining one mirror, so a new
     * mutation site that forgot the hand assignment read stale for a render and
     * the effect hid it.
     */
    const selectedPostIdRef = useRef<string | null>(null);
    const metadataTabRef = useRef(false);
    const currentPostRef = useRef<Post | null>(null);
    const draftsRef = useRef<PostSummary[]>([]);
    const readyRef = useRef<PostSummary[]>([]);
    const publishedRef = useRef<PostSummary[]>([]);
    const publishedTotalRef = useRef(0);
    const expiredRef = useRef<PostSummary[]>([]);
    const expiredTotalRef = useRef(0);

    const flushRightPaneChanges = useCallback(
      async () => (await rightPaneRef.current?.flushPendingChanges()) ?? true,
      []
    );

    // Only metadata still flushes renderer-side; content edits stream to the
    // main-process post store as they happen, so navigation cannot orphan them.
    const flushPendingChanges = useCallback(async () => {
      return (await flushRightPaneChanges()) ?? true;
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
        const pubOffset = opts?.publishedOffset ?? 0;
        const expOffset = opts?.expiredOffset ?? 0;
        const data = await listPosts(pubOffset, pubBatchSize, expOffset);

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
      if (settings.timezone?.trim() && isValidTimeZone(settings.timezone)) setTimezone(settings.timezone);
      setContentFont(settings.contentFont);
      setUiFontFamily(settings.uiFontFamily?.trim() ?? "");
    }, []);

    useEffect(() => {
      // The effect owns this global side effect, so a settings request that
      // resolves after unmount can only attempt an ignored state update; it
      // cannot overwrite the next workspace's font on document.documentElement.
      const root = document.documentElement;
      const previous = root.style.getPropertyValue("--bm-font-ui");
      if (uiFontFamily) root.style.setProperty("--bm-font-ui", uiFontFamily);
      else root.style.removeProperty("--bm-font-ui");
      return () => {
        if (previous) root.style.setProperty("--bm-font-ui", previous);
        else root.style.removeProperty("--bm-font-ui");
      };
    }, [uiFontFamily]);

    const loadConfig = useCallback(async () => {
      const [nextTargets, settings] = await Promise.all([listTargets(), getSettings()]);
      setTargets(nextTargets);
      applySettings(settings);
    }, [applySettings]);

    useEffect(() => {
      let cancelled = false;
      setLoadError(null);
      // Surface load failures instead of swallowing them: a failed targets load
      // would otherwise leave the New Post dialog silently empty.
      Promise.all([loadPosts(), loadConfig()]).catch((err) => {
        if (cancelled) return;
        setLoadError(presentFailure(
          "This workspace could not be loaded. Reopen it to try again.",
          "renderer: workspace load failed",
          err,
        ));
      });
      return () => {
        cancelled = true;
      };
    }, [loadConfig, loadPosts]);

    /**
     * Re-reads the workspace config after Settings closes — and the posts with it.
     *
     * The posts are not optional here. Renaming a target rewrites the `target`
     * field in every post file, so reloading only the targets left the open post
     * carrying a name that matched nothing: `currentTarget` went null, the
     * Metadata tab vanished from the strip, and MetadataTab's unmount cleared its
     * one-second autosave timers WITHOUT persisting — anything typed in the last
     * second was gone. The left list and the centre toolbar kept showing the old
     * name too.
     */
    const reloadConfig = useCallback(() => {
      setLoadError(null);

      void (async () => {
        try {
          // Flush FIRST. Renaming a target can make the Metadata tab disappear
          // (its target no longer requires metadata, or no longer matches), and
          // MetadataTab's unmount clears its one-second autosave timers without
          // persisting — so anything typed in the last second went with it.
          const flushed = await flushRightPaneChanges();
          if (!flushed) {
            setLoadError("Metadata changes could not be saved. Resolve them before reloading settings.");
            return;
          }
          await Promise.all([loadConfig(), loadPosts()]);

          // The open post too: a rename rewrites `target` in every post FILE, so
          // the copy in memory is stale and would match no target at all.
          const openId = selectedPostIdRef.current;
          if (openId) {
            setCurrentPost(await getPost(openId));
          }
        } catch (err) {
          setLoadError(presentFailure(
            "Settings changed, but this workspace could not be refreshed. Reopen the workspace to use the saved settings.",
            "renderer: workspace settings refresh failed",
            err,
          ));
        }
      })();

      setAnalysisPromptsVersion((n) => n + 1);
    }, [flushRightPaneChanges, loadConfig, loadPosts]);

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
        // A control deeper in the tree may have already consumed this event; the
        // convention is that chrome shortcuts stand down when it did.
        if (e.defaultPrevented) return;

        if (!hasMod(e)) return;

        // While an IME candidate is pending, the chord belongs to the composition — even Cmd+N,
        // which otherwise fires inside an input, stands down until it commits (text-input-ime).
        if (isComposingEvent(e)) return;

        if (isEditableTarget(e.target) && shadowsMacTextBinding(e)) return;

        // App-level dialogs use their conventional chords and open from anywhere,
        // like menu accelerators (Cmd/Ctrl+, for Settings, Cmd/Ctrl+/ or ? for the
        // shortcuts reference), so they sit ahead of the input-focus guards below.
        if (e.key === ",") {
          e.preventDefault();
          setSettingsOpen(true);
          return;
        }
        if (e.key === "/" || e.key === "?") {
          e.preventDefault();
          setShortcutsOpen(true);
          return;
        }

        // A SELECT owns its own type-ahead, so a bare letter belongs to it.
        if ((e.target as HTMLElement).tagName === "SELECT") return;

        // No blanket stand-down inside a text field. There used to be one, and
        // it made every chord below dead exactly where the user is: the
        // CodeMirror editor's event target is a DIV inside its contenteditable,
        // so reaching for "Run analysis" or a tab while writing did nothing, with
        // no indication why — while the shortcuts modal documented them all
        // unconditionally. None of these chords shadows a text-field binding a
        // web view actually implements; the one rule that does bite, macOS's
        // Ctrl half belonging to the text system, is applied above.

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
          // Metadata is only a tab when the post's target asks for it. Without
          // this the chord fell through to the pane, which quietly redirected to
          // Analysis — a documented shortcut landing somewhere else entirely.
          if (tab === "Metadata" && !metadataTabRef.current) return;
          e.preventDefault();
          setRightTab(tab);
        }
      };

      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, [anyModalOpen]);

    const handleCreatePost = async (target: string, language: string, sourceId?: string) => {
      const post = await createPost(target, language, sourceId);
      setNewPostOpen(false);
      await loadPosts();
      await selectPost(post.frontMatter.id);
    };

    const handlePostDeleted = useCallback(() => {
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
        setLoadError(presentFailure(
          "The post list could not be refreshed. Reopen the workspace to try again.",
          "renderer: post list refresh failed",
          err,
        ));
      });
    }, [loadPosts, selectPost]);

    /**
     * Re-buckets the lists after one post changed, and publishes the result to
     * both the refs and the state.
     *
     * The two callers — a full post mutation and a background content save —
     * had a copy of this each: the same bucket call plus six ref writes and
     * eight setters, twenty-odd lines apiece. They had already begun to differ.
     */
    const applyMutatedPost = useCallback(
      (summary: PostSummary, status: PostStatus, postId: string) => {
        // The open post is the only fallback for a post that is in no loaded
        // list (it was reached via a source link, so its bucket is off the page).
        const openPostStatus =
          currentPostRef.current?.frontMatter.id === postId
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
          status,
          openPostStatus,
        );

        // Eagerly, because the next mutation may land before React re-renders.
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
      },
      [],
    );

    const handlePostUpdated = useCallback((result: PostMutationResult) => {

      // The update returns the canonical list summary (including its derived
      // excerpt); use it verbatim for the list and the full post for the editor.
      const summary: PostSummary = { frontMatter: result.summary };
      const id = result.frontMatter.id;

      applyMutatedPost(summary, result.frontMatter.status, id);

      if (id === selectedPostIdRef.current) {
        setCurrentPost(result);
      }
    }, [applyMutatedPost]);

    // Background content saves (the main process owns the write cadence) update
    // the same list buckets; there is no full post payload and no need for one —
    // the editor already shows the text, only the projection changed.
    useEffect(() => {
      const off = onPostContentSaved((event) => {
        applyMutatedPost({ frontMatter: event.summary }, event.summary.status, event.postId);
      });
      return off;
    }, [applyMutatedPost]);

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
        setLoadError(presentFailure(
          "More published posts could not be loaded. The posts already shown are unchanged; try again.",
          "renderer: published post pagination failed",
          err,
        ));
      });
    }, [loadPosts, publishedOffset]);

    const handleLoadMoreExpired = useCallback(() => {
      setLoadError(null);
      loadPosts({ expiredOffset, append: "expired" }).catch((err) => {
        setLoadError(presentFailure(
          "More expired posts could not be loaded. The posts already shown are unchanged; try again.",
          "renderer: expired post pagination failed",
          err,
        ));
      });
    }, [loadPosts, expiredOffset]);

    const handleRevealCurrentLogFile = useCallback(async () => {
      try {
        setLoadError(null);
        await revealCurrentLogFile();
      } catch (err) {
        setLoadError(presentFailure(
          "The current log could not be revealed. Open the logs folder from About and try again.",
          "renderer: reveal current log failed",
          err,
        ));
      }
    }, []);

    selectedPostIdRef.current = selectedPostId;
    currentPostRef.current = currentPost;

    const currentTarget =
      currentPost && currentPost.frontMatter.id === selectedPostId
        ? targets.find((target) => target.name === currentPost.frontMatter.target) ?? null
        : null;
    metadataTabRef.current = currentTarget?.requiresMetadata ?? false;
    const postLoading =
      Boolean(selectedPostId) &&
      currentPost?.frontMatter.id !== selectedPostId;

    return (
      <div className="workspace-session">
        {loadError && (
          <OperationalResult
            severity="error"
            className="toolbar-error"
            dismissClassName="toolbar-error-dismiss"
            onDismiss={() => setLoadError(null)}
          >
            {loadError}
          </OperationalResult>
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
            timezone={timezone}
          />
          <div className="pane-divider" onMouseDown={onStartLeftDrag} />
          {selectedPostId ? (
            <>
              <CenterPane
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
                contentFont={contentFont}
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
                contentFont={contentFont}
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
