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
  listPostPage,
  createPost,
  getPost,
  getWorkspaceConfig,
  openRecordsWindow,
  onPostContentSaved,
  onWindowActivated,
} from "./api";
import { presentFailure } from "./util/presentFailure";
import { PaneDivider } from "./components/PaneDivider";
import { LEFT_MIN, LEFT_MAX, RIGHT_MIN, RIGHT_MAX } from "./paneConstants";
import { LeftPane } from "./components/LeftPane";
import { OperationalResult } from "./components/OperationalResult";
import { ListedMessageView } from "./components/NamedItems";
import { finalSegment } from "./util/shortenedText";
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
  PostDeleteResult,
  EditablePostMetadata,
  PostMutationResult,
  PostStatus,
  PostSummary,
  Settings,
  Target,
  UnreadablePostFile,
  Workspace,
} from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { useAnyModalOpen } from "./hooks/useModalStack";
import { isComposingEvent } from "./hooks/useComposing";
import { isEditableTarget, matchesShortcut, shadowsMacTextBinding, SHORTCUTS, type Shortcut } from "./util/shortcuts";
import { pickAdjacentPostId } from "./util/selection";
import {
  applyPostMutationToLists,
  emptyPostLists,
  listsFromResponse,
  removePostFromLists,
  type PostLists,
} from "./util/postBuckets";
import { FIRST_PAGES, PAGED_POST_STATUSES, type PagedPostStatus } from "@shared/postStatus";
import type { MessageKey } from "@shared/i18n/catalogues";
import { effectiveTimeZone, systemTimeZone } from "@shared/timeZone";
import { useI18n } from "./i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";

// Activations closer together than this read the list once.
const ACTIVATION_COALESCE_MS = 300;

// What a failed "load more" of each paged section says.
const MORE_FAILED: Readonly<Record<PagedPostStatus, MessageKey>> = {
  discarded: "session.moreDiscardedFailed",
  published: "session.morePublishedFailed",
  retired: "session.moreRetiredFailed",
};

// The right pane tab each tab shortcut opens.
const TAB_SHORTCUTS: ReadonlyArray<readonly [Shortcut, RightTab]> = [
  [SHORTCUTS.tabAnalysis, "Analysis"],
  [SHORTCUTS.tabImaging, "Imaging"],
  [SHORTCUTS.tabAssets, "Assets"],
  [SHORTCUTS.tabPreview, "Preview"],
  [SHORTCUTS.tabMetadata, "Metadata"],
];

const DEFAULT_WATERMARK =
  "Consider starting with an outline:\n- Who is this for?\n- What should they take away?\n- What are the key points?";

function withMetadata(post: Post, edits: EditablePostMetadata): Post {
  const frontMatter = { ...post.frontMatter };
  for (const [key, value] of Object.entries(edits)) {
    if (value === null) delete frontMatter[key];
    else if (value !== undefined) frontMatter[key] = value;
  }
  return { ...post, frontMatter };
}

interface WorkspaceSessionProps {
  workspace: Workspace;
  // The pane row, surfaced to the parent so its splitter clamp can measure the
  // live container width.
  appLayoutRef: RefObject<HTMLDivElement | null>;
  leftWidth: number;
  rightWidth: number;
  onStartLeftDrag: MouseEventHandler<HTMLDivElement>;
  onStartRightDrag: MouseEventHandler<HTMLDivElement>;
  onLeftWidthChange: (width: number) => void;
  onRightWidthChange: (width: number) => void;
  onLeftWidthCommit: (width: number) => void;
  onRightWidthCommit: (width: number) => void;
  onSwitchWorkspace: () => void;
  /** A rename saved from Settings, so the app shows the open workspace's new name. */
  onWorkspaceUpdated: (workspace: Workspace) => void;
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
      onLeftWidthChange,
      onRightWidthChange,
      onLeftWidthCommit,
      onRightWidthCommit,
      onSwitchWorkspace,
      onWorkspaceUpdated,
    },
    ref
  ) {
    const anyModalOpen = useAnyModalOpen();
    const [lists, setLists] = useState<PostLists>(emptyPostLists);
    const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
    const [navHistory, setNavHistory] = useState<string[]>([]);
    const [targets, setTargets] = useState<Target[]>([]);
    const [supportedLanguages, setSupportedLanguages] = useState<string[]>(["en"]);
    const [pubBatchSize, setPubBatchSize] = useState(50);
    const [watermark, setWatermark] = useState(DEFAULT_WATERMARK);
    const [extraFieldWatermark, setExtraFieldWatermark] = useState("");
    const [contentFont, setContentFont] = useState<ContentFont>(DEFAULT_CONTENT_FONT);
    const [uiFontFamily, setUiFontFamily] = useState("");
    const [timezone, setTimezone] = useState(systemTimeZone);
    const [editorContent, setEditorContent] = useState("");
    const [currentPost, setCurrentPost] = useState<Post | null>(null);
    // The open post as last reread after Settings closed, for the centre pane's own copy.
    const [rereadPost, setRereadPost] = useState<Post | null>(null);
    const [exportOpen, setExportOpen] = useState(false);
    const [newPostOpen, setNewPostOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const [aboutOpen, setAboutOpen] = useState(false);
    const [rightTab, setRightTab] = useState<RightTab>("Analysis");
    const [analysisTrigger, setAnalysisTrigger] = useState(0);
    const [analysisPromptsVersion, setAnalysisPromptsVersion] = useState(0);
    const { t, text } = useI18n();
    const [loadError, setLoadError] = useState<Message | null>(null);
    const [deleteWarning, setDeleteWarning] = useState(false);
    // Post files the list leaves out because they cannot be read. A dismissed
    // set stays hidden until the set changes.
    const [unreadablePosts, setUnreadablePosts] = useState<UnreadablePostFile[]>([]);
    const [dismissedUnreadable, setDismissedUnreadable] = useState<string | null>(null);
    // Stored settings that could not be used and read as their built-ins; the
    // file keeps them until the user changes those settings.
    const [configNotice, setConfigNotice] = useState<Message | null>(null);
    const editorRef = useRef<MarkdownEditorHandle>(null);
    const rightPaneRef = useRef<RightPaneHandle>(null);
    /**
     * Mirrors of state that callbacks registered once — the global key handler,
     * an in-flight load — have to read at their own moment rather than at the
     * render that created them.
     *
     * Two kinds, and the difference decides where each is written:
     *
     *   - read only LATER (selectedPostId, metadataTab): assigned
     *     during render, below. Always current by the time any event fires.
     *   - read back in the SAME tick as their setter (current post and lists):
     *     assigned eagerly by their publication owner, before another callback
     *     can read them without a render in between.
     *
     * Each ref has exactly one of these, never also a post-render effect
     * copying state into it: that copy lands too late for a same-tick read, and
     * with two mechanisms maintaining one mirror, a mutation site that forgot
     * its hand assignment would read stale for a render while the effect hid it.
     */
    const mounted = useRef(true);
    const selectionRequest = useRef(0);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; selectionRequest.current += 1; }; }, []);
    const selectedPostIdRef = useRef<string | null>(null);
    const metadataTabRef = useRef(false);
    const currentPostRef = useRef<Post | null>(null);
    const postRequest = useRef(0);
    const readingMetadata = useRef<EditablePostMetadata | null>(null);
    // One owner publishes canonical front matter to both panes. Its request
    // version also retires reads overtaken by a mutation. Accepted field edits
    // during a read overlay its result, just as the storage buffer overlays disk.
    const adoptSelectedPost = useCallback((post: Post, retireRead = true) => {
      if (!mounted.current || selectedPostIdRef.current !== post.frontMatter.id) return;
      if (retireRead) {
        ++postRequest.current;
        readingMetadata.current = null;
      }
      currentPostRef.current = post;
      setCurrentPost(post);
      setRereadPost(post);
    }, []);
    const refreshSelectedPost = useCallback(async () => {
      const id = selectedPostIdRef.current;
      if (!id) return;
      const request = ++postRequest.current;
      const edits: EditablePostMetadata = {};
      readingMetadata.current = edits;
      try {
        const post = await getPost(id, workspace.id);
        if (!mounted.current || selectedPostIdRef.current !== id || postRequest.current !== request) return;
        adoptSelectedPost(Object.keys(edits).length ? withMetadata(post, edits) : post);
      } catch (error) {
        if (!mounted.current || selectedPostIdRef.current !== id || postRequest.current !== request) return;
        throw error;
      } finally {
        if (readingMetadata.current === edits) readingMetadata.current = null;
      }
    }, [workspace.id, adoptSelectedPost]);
    const listsRef = useRef<PostLists>(lists);
    // The lists' latest-request token: every read of the lists and every write
    // the app makes to them advances it, so a read that was out meanwhile knows
    // it is older and is dropped.
    const listRequestRef = useRef(0);

    // Eagerly, because the next mutation may land before React re-renders.
    const commitLists = useCallback((next: PostLists) => {
      listsRef.current = next;
      setLists(next);
    }, []);

    const flushRightPaneChanges = useCallback(
      async () => (await rightPaneRef.current?.flushPendingChanges()) ?? true,
      []
    );

    // Content and metadata edits both stream to the main-process post store as
    // they happen, so navigation cannot orphan them. What remains is cancelling
    // metadata generation and reporting a metadata value the store refused.
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
      async (id: string | null, options?: { skipFlush?: boolean; mayAdopt?: () => boolean }) => {
        const request = ++selectionRequest.current;
        if (id === selectedPostIdRef.current) return true;
        if (!options?.skipFlush) {
          const flushed = await flushPendingChanges();
          if (!flushed) return false;
        }
        if (!mounted.current || request !== selectionRequest.current || (options?.mayAdopt && !options.mayAdopt())) return false;
        selectedPostIdRef.current = id;
        setSelectedPostId(id);
        ++postRequest.current;
        readingMetadata.current = null;
        currentPostRef.current = null;
        setCurrentPost(null);
        setRereadPost(null);
        setEditorContent("");
        return true;
      },
      [flushPendingChanges]
    );

    // Appending reads only the requested archive section; full refreshes keep
    // their existing all-status projection.
    const loadPosts = useCallback(
      async (append?: PagedPostStatus) => {
        const request = ++listRequestRef.current;
        if (append) {
          const page = await listPostPage(append, listsRef.current[append].posts.length, pubBatchSize, workspace.id);
          if (!mounted.current || request !== listRequestRef.current) return;
          setUnreadablePosts(page.unreadable ?? []);
          const current = listsRef.current;
          commitLists({ ...current, [append]: { posts: [...current[append].posts, ...page.posts], total: page.total } });
          return;
        }
        const data = await listPosts(FIRST_PAGES, pubBatchSize, workspace.id);
        if (!mounted.current || request !== listRequestRef.current) return;
        setUnreadablePosts(data.unreadable ?? []);
        commitLists(listsFromResponse(data));
      },
      [pubBatchSize, commitLists, workspace.id]
    );

    /**
     * Reads the lists again as they are on disk, keeping as many posts of each
     * paged section loaded as are shown now. Post files can change outside the
     * app (git, another editor) and nothing watches them. The selected-post
     * refresh separately updates front matter while the editor retains text.
     */
    const refreshPosts = useCallback(async () => {
      const request = ++listRequestRef.current;
      const shown = (status: PagedPostStatus) => Math.max(pubBatchSize, listsRef.current[status].posts.length);
      const data = await listPosts(FIRST_PAGES, Math.max(...PAGED_POST_STATUSES.map(shown)), workspace.id);
      // The app changed the lists while this read was out: they are newer.
      if (!mounted.current || request !== listRequestRef.current) return;
      setUnreadablePosts(data.unreadable ?? []);

      const fresh = listsFromResponse(data);
      for (const status of PAGED_POST_STATUSES) {
        fresh[status] = { ...fresh[status], posts: fresh[status].posts.slice(0, shown(status)) };
      }
      commitLists(fresh);
    }, [pubBatchSize, commitLists, workspace.id]);

    useEffect(() => () => {
      listRequestRef.current += 1;
    }, [pubBatchSize]);

    // The window coming back to the front is when edits made elsewhere matter.
    useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = onWindowActivated(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          Promise.all([refreshPosts(), refreshSelectedPost()]).catch((err: unknown) => {
            if (!mounted.current) return;
            setLoadError(presentFailure(
              message("session.activationRefreshFailed"),
              "renderer: workspace refresh on activation failed",
              err,
            ));
          });
        }, ACTIVATION_COALESCE_MS);
      });
      return () => {
        off();
        clearTimeout(timer);
      };
    }, [refreshPosts, refreshSelectedPost]);

    const applySettings = useCallback((settings: Settings) => {
      if (settings.postsPerLoad) setPubBatchSize(settings.postsPerLoad);
      setWatermark(settings.editorWatermark);
      setExtraFieldWatermark(settings.extraFieldWatermark);
      if (settings.supportedLanguages?.length) setSupportedLanguages(settings.supportedLanguages);
      setTimezone(effectiveTimeZone(settings.timezone));
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
      const { targets: nextTargets, settings, notice } = await getWorkspaceConfig(workspace.id);
      if (!mounted.current) return;
      setTargets(nextTargets);
      applySettings(settings);
      setConfigNotice(notice);
    }, [applySettings, workspace.id]);

    useEffect(() => {
      let cancelled = false;
      setLoadError(null);
      // Surface load failures instead of swallowing them: a failed targets load
      // would otherwise leave the New Post dialog silently empty.
      Promise.all([loadPosts(), loadConfig()]).catch((err) => {
        if (cancelled) return;
        setLoadError(presentFailure(
          message("session.loadFailed"),
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
     * carrying a name that matched nothing: `currentTarget` went null and the
     * Metadata tab vanished from the strip. The reread open post goes to the
     * session and to the centre pane, whose toolbar shows its own copy.
     */
    const reloadConfig = useCallback(() => {
      if (!mounted.current) return;
      setLoadError(null);

      void (async () => {
        try {
          // Flush FIRST. Renaming a target can make the Metadata tab disappear
          // (its target no longer requires metadata, or no longer matches), and
          // a refused value in it must be reported while it is still on screen.
          const flushed = await flushRightPaneChanges();
          if (!flushed) {
            setLoadError(message("session.metadataUnsaved"));
            return;
          }
          if (!mounted.current) return;
          await Promise.all([loadConfig(), loadPosts()]);
          if (!mounted.current) return;

          await refreshSelectedPost();
        } catch (err) {
          setLoadError(presentFailure(
            message("session.refreshFailed"),
            "renderer: workspace settings refresh failed",
            err,
          ));
        }
      })();

      setAnalysisPromptsVersion((n) => n + 1);
    }, [flushRightPaneChanges, loadConfig, loadPosts, refreshSelectedPost]);

    useEffect(() => {
      // Any open modal/dialog owns the keyboard; global shortcuts must not
      // mutate state behind it. The modal stack is the single source of truth
      // here, so this also covers confirms opened deep in the pane tree, not
      // just the top-level session modals.
      if (anyModalOpen) return;

      const handler = (e: KeyboardEvent) => {
        // A control deeper in the tree may have already consumed this event; the
        // convention is that chrome shortcuts stand down when it did.
        if (e.defaultPrevented) return;

        // While an IME candidate is pending, the chord belongs to the composition — even Cmd+N,
        // which otherwise fires inside an input, stands down until it commits (text-input-ime).
        if (isComposingEvent(e)) return;

        if (isEditableTarget(e.target) && shadowsMacTextBinding(e)) return;

        // App-level dialogs open from anywhere, like menu accelerators, so they
        // sit ahead of the SELECT guard below.
        if (matchesShortcut(SHORTCUTS.settings, e)) {
          e.preventDefault();
          setSettingsOpen(true);
          return;
        }
        if (matchesShortcut(SHORTCUTS.showShortcuts, e)) {
          e.preventDefault();
          setShortcutsOpen(true);
          return;
        }

        // A SELECT owns its own type-ahead, so a bare letter belongs to it.
        if ((e.target as HTMLElement).tagName === "SELECT") return;

        // These chords fire inside text fields too, the markdown editor
        // included, because that is where the user is while writing. None of
        // them shadows a text-field binding a web view implements; the one rule
        // that does bite, macOS's Ctrl half belonging to the text system, is
        // applied above.

        if (matchesShortcut(SHORTCUTS.newPost, e)) {
          e.preventDefault();
          setNewPostOpen(true);
          return;
        }
        if (!selectedPostIdRef.current) return;
        if (matchesShortcut(SHORTCUTS.exportPost, e)) {
          e.preventDefault();
          setExportOpen(true);
          return;
        }
        if (matchesShortcut(SHORTCUTS.runAnalysis, e)) {
          e.preventDefault();
          setRightTab("Analysis");
          setAnalysisTrigger((n) => n + 1);
          return;
        }
        const tab = TAB_SHORTCUTS.find(([shortcut]) => matchesShortcut(shortcut, e))?.[1];
        if (!tab) return;
        // Metadata is a tab only when the post's target asks for it; otherwise
        // the chord would reach the pane, which shows Analysis instead.
        if (tab === "Metadata" && !metadataTabRef.current) return;
        e.preventDefault();
        setRightTab(tab);
      };

      window.addEventListener("keydown", handler);
      return () => window.removeEventListener("keydown", handler);
    }, [anyModalOpen]);

    const handleCreatePost = async (target: string, language: string, sourceId?: string, ownsModal: () => boolean = () => true) => {
      const selection = selectionRequest.current;
      const mayAdopt = () => mounted.current && ownsModal() && selectionRequest.current === selection;
      const post = await createPost(target, language, sourceId, workspace.id);
      if (!mounted.current) return;
      // The post was created even if its optional list refresh fails.
      try { await loadPosts(); }
      catch (err) { if (mounted.current) setLoadError(presentFailure(message("session.postListFailed"), "renderer: post list refresh after creation failed", err)); }
      if (!mayAdopt()) return;
      const selected = await selectPost(post.frontMatter.id, { mayAdopt: () => mounted.current && ownsModal() });
      if (selected && mounted.current && ownsModal()) setNewPostOpen(false);
    };

    const handlePostDeleted = useCallback((deletedId: string, result: PostDeleteResult) => {
      if (!mounted.current) return false;
      listRequestRef.current += 1;
      if (result.cleanupIncomplete) setDeleteWarning(true);
      // Drop only the deleted post from the back stack (it can't be navigated to
      // anymore), keeping the rest so Back still works through the other posts.
      setNavHistory((history) => history.filter((id) => id !== deletedId));

      // Delete retains its submitted identity, even after navigation. It lives in at most one loaded
      // section. Drop it from that section and move the selection to its
      // neighbour, keeping the user in place. Only a post reached via a source
      // link can be missing from every loaded page — fall back to a reload then.
      const removed = removePostFromLists(listsRef.current, deletedId);
      if (removed) {
        const nextId = pickAdjacentPostId(listsRef.current[removed.status].posts, deletedId);
        commitLists(removed.lists);
        if (selectedPostIdRef.current === deletedId) void selectPost(nextId, { skipFlush: true });
        return true;
      }

      // Not in any loaded section (rare): clear and reload to resync.
      if (selectedPostIdRef.current === deletedId) void selectPost(null, { skipFlush: true });
      loadPosts().catch((err) => {
        setLoadError(presentFailure(
          message("session.postListFailed"),
          "renderer: post list refresh failed",
          err,
        ));
      });
      return true;
    }, [loadPosts, selectPost, commitLists]);

    /**
     * Re-sections the lists after one post changed, for a full post mutation
     * and a background content save alike.
     */
    const applyMutatedPost = useCallback(
      (summary: PostSummary, status: PostStatus, postId: string) => {
        // The open post is the only fallback for a post that is in no loaded
        // list (it was reached via a source link, so its section is off the page).
        const openPostStatus =
          currentPostRef.current?.frontMatter.id === postId
            ? currentPostRef.current.frontMatter.status
            : null;

        listRequestRef.current += 1;
        commitLists(applyPostMutationToLists(listsRef.current, summary, status, openPostStatus));
      },
      [commitLists],
    );

    const handlePostUpdated = useCallback((result: PostMutationResult) => {
      if (!mounted.current) return;

      // The update returns the canonical list summary (including its derived
      // excerpt); use it verbatim for the list and the full post for the editor.
      const summary: PostSummary = { frontMatter: result.summary };
      const id = result.frontMatter.id;

      applyMutatedPost(summary, result.frontMatter.status, id);

      adoptSelectedPost(result);
    }, [applyMutatedPost, adoptSelectedPost]);

    // A metadata edit the store has buffered: fold it into the open post, so
    // views reading its front matter (the export's slug) show it at once. The
    // list catches up from the save event once the store writes it.
    const handleMetadataEdited = useCallback((postId: string, edits: EditablePostMetadata) => {
      const post = currentPostRef.current;
      if (!post || post.frontMatter.id !== postId) return;
      if (readingMetadata.current) Object.assign(readingMetadata.current, edits);
      adoptSelectedPost(withMetadata(post, edits), false);
    }, [adoptSelectedPost]);

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

    const handleLoadMore = useCallback((status: PagedPostStatus) => {
      setLoadError(null);
      loadPosts(status).catch((err) => {
        setLoadError(presentFailure(
          message(MORE_FAILED[status]),
          `renderer: ${status} post pagination failed`,
          err,
        ));
      });
    }, [loadPosts]);

    const handleOpenRecords = useCallback(async () => {
      try {
        setLoadError(null);
        await openRecordsWindow();
      } catch (err) {
        setLoadError(presentFailure(
          message("session.openRecordsFailed"),
          "renderer: records window open failed",
          err,
        ));
      }
    }, []);

    selectedPostIdRef.current = selectedPostId;

    const currentTarget =
      currentPost && currentPost.frontMatter.id === selectedPostId
        ? targets.find((target) => target.name === currentPost.frontMatter.target) ?? null
        : null;
    metadataTabRef.current = currentTarget?.requiresMetadata ?? false;
    const postLoading =
      Boolean(selectedPostId) &&
      currentPost?.frontMatter.id !== selectedPostId;
    const unreadableKey = unreadablePosts.map((file) => file.path).join("\n");

    return (
      <div className="workspace-session">
        {loadError && (
          <OperationalResult
            severity="error"
            className="toolbar-error"
            dismissClassName="toolbar-error-dismiss"
            onDismiss={() => setLoadError(null)}
          >
            {text(loadError)}
          </OperationalResult>
        )}
        {deleteWarning && (
          <OperationalResult severity="warning" className="toolbar-warning" onDismiss={() => setDeleteWarning(false)}>
            {t("session.deleteCleanupIncomplete")}
          </OperationalResult>
        )}
        {unreadablePosts.length > 0 && unreadableKey !== dismissedUnreadable && (
          <OperationalResult
            severity="warning"
            className="toolbar-warning"
            onDismiss={() => setDismissedUnreadable(unreadableKey)}
          >
            {/* A few file names here; each file's whole path and what to do
                about it are in the full list behind the disclosure. */}
            <ListedMessageView listed={{
              message: message("session.unreadablePosts", { count: unreadablePosts.length }),
              items: unreadablePosts.map((file) => ({
                name: finalSegment(file.path),
                line: message(file.newer ? "store.newerFormat" : "store.unreadable", { path: file.path }),
              })),
            }} />
          </OperationalResult>
        )}
        {configNotice && (
          <OperationalResult
            severity="warning"
            className="toolbar-warning"
            onDismiss={() => setConfigNotice(null)}
          >
            {text(configNotice)}
          </OperationalResult>
        )}
        <div
          ref={appLayoutRef}
          className="app-layout"
          style={{ "--bm-left": `${leftWidth}px`, "--bm-right": `${rightWidth}px` } as CSSProperties}
        >
          <LeftPane
            lists={lists}
            selectedPostId={selectedPostId}
            onSelectPost={(id) => {
              void (async () => {
                const switched = await selectPost(id);
                if (switched) setNavHistory([]);
              })();
            }}
            onNewPost={() => setNewPostOpen(true)}
            onLoadMore={handleLoadMore}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onOpenAbout={() => setAboutOpen(true)}
            onOpenRecords={handleOpenRecords}
            onSwitchWorkspace={onSwitchWorkspace}
            workspaceName={workspace.name}
            timezone={timezone}
          />
          <PaneDivider
            label={t("app.resizePosts")}
            width={leftWidth}
            min={LEFT_MIN}
            max={LEFT_MAX}
            sign={1}
            onMouseDown={onStartLeftDrag}
            onWidthChange={onLeftWidthChange}
            onCommitWidth={onLeftWidthCommit}
          />
          {selectedPostId ? (
            <>
              <CenterPane
                key={selectedPostId}
                workspaceId={workspace.id}
                postId={selectedPostId}
                onPostUpdated={handlePostUpdated}
                onPostDeleted={handlePostDeleted}
                onContentChange={setEditorContent}
                onPostLoaded={(post) => adoptSelectedPost(post, false)}
                onExport={() => setExportOpen(true)}
                onSelectPost={handleNavigateToPost}
                onGoBack={navHistory.length > 0 ? handleGoBack : undefined}
                onBeforeStatusChange={flushRightPaneChanges}
                rereadPost={rereadPost}
                pubBatchSize={pubBatchSize}
                watermark={watermark}
                contentFont={contentFont}
                editorRef={editorRef}
              />
              <PaneDivider
                label={t("app.resizeTools")}
                width={rightWidth}
                min={RIGHT_MIN}
                max={RIGHT_MAX}
                sign={-1}
                onMouseDown={onStartRightDrag}
                onWidthChange={onRightWidthChange}
                onCommitWidth={onRightWidthCommit}
              />
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
                onMetadataEdited={handleMetadataEdited}
                activeTab={rightTab}
                onTabChange={setRightTab}
                analysisTrigger={analysisTrigger}
                analysisPromptsVersion={analysisPromptsVersion}
                onInsertAtCursor={(text) => editorRef.current?.insertAtCursor(text)}
                contentFont={contentFont}
                loading={postLoading}
              />
            </>
          ) : (
            <div className="pane-empty">{t("session.empty")}</div>
          )}
          {settingsOpen && (
            <SettingsModal
              workspaceId={workspace.id}
              workspaceName={workspace.name}
              workspaceFolder={workspace.dataDirectory}
              onClose={() => setSettingsOpen(false)}
              onSettingsChanged={reloadConfig}
              onWorkspaceRenamed={onWorkspaceUpdated}
            />
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
