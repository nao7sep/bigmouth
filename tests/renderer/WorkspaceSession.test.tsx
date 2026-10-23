import { LEFT_MIN, LEFT_MAX, RIGHT_MIN, RIGHT_MAX } from "@renderer/paneConstants";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type {
  EditablePostMetadata,
  PostFrontMatter,
  Post,
  PostListResponse,
  PostPageResponse,
  PostMutationResult,
  PostSummary,
  Settings,
  WorkspaceConfigView,
  Target,
  Workspace,
} from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { matchesShortcut, SHORTCUT_GROUPS } from "@renderer/util/shortcuts";

// WorkspaceSession is the session orchestrator. It reaches the main process only
// through these five api calls; everything else it owns is state, routing, and
// the callbacks it threads down to the panes.
// Content-save events from the main-process saver; the captured listeners let
// tests play the main process's part.
const savedListeners = vi.hoisted(() => new Set<(e: { postId: string; summary: unknown }) => void>());
// The window's activations, played by the tests.
const activationListeners = vi.hoisted(() => new Set<() => void>());
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  listPosts: vi.fn(),
  listPostPage: vi.fn(),
  createPost: vi.fn(),
  getWorkspaceConfig: vi.fn(),
  getPost: vi.fn(),
  openRecordsWindow: vi.fn(),
  onPostContentSaved: (cb: (e: { postId: string; summary: unknown }) => void) => {
    savedListeners.add(cb);
    return () => savedListeners.delete(cb);
  },
  onWindowActivated: (cb: () => void) => {
    activationListeners.add(cb);
    return () => activationListeners.delete(cb);
  },
}));

// The modal-stack hook decides whether global shortcuts are live. Drive it from a
// mutable flag so a test can simulate "a modal owns the keyboard."
let anyModalOpen = false;
vi.mock("@renderer/hooks/useModalStack", () => ({
  useAnyModalOpen: () => anyModalOpen,
}));

// --- Child stand-ins -------------------------------------------------------
//
// Each heavy child is replaced with a stand-in that (a) records the latest props
// it received, so tests can assert what WorkspaceSession passed, and (b) exposes
// the callbacks as buttons so tests can drive the session's handlers. The two
// pane components forward an imperative flush handle, which the session calls
// before any post switch; the stand-ins surface a spy for it.

type AnyProps = Record<string, unknown>;
const props: Record<string, AnyProps> = {};

const rightFlush = vi.fn<() => Promise<boolean>>();
const insertAtCursor = vi.fn();

vi.mock("@renderer/components/LeftPane", () => ({
  LeftPane: (p: AnyProps) => {
    props.left = p;
    const lists = p.lists as Record<string, { posts: PostSummary[]; total: number }>;
    const shown = (status: string) => lists[status].posts.map((d) => d.frontMatter.id).join(",");
    return (
      <div data-testid="left">
        <span data-testid="left-drafts">{shown("draft")}</span>
        <span data-testid="left-discarded">{shown("discarded")}</span>
        <span data-testid="left-verified">{shown("verified")}</span>
        <span data-testid="left-published">{shown("published")}</span>
        <span data-testid="left-retired">{shown("retired")}</span>
        <span data-testid="left-published-total">{String(lists.published.total)}</span>
        <span data-testid="left-retired-total">{String(lists.retired.total)}</span>
        <span data-testid="left-selected">{String(p.selectedPostId ?? "")}</span>
        <span data-testid="left-ws-name">{String(p.workspaceName)}</span>
        <span data-testid="left-timezone">{String(p.timezone)}</span>
        <button data-testid="left-select-a" onClick={() => (p.onSelectPost as (id: string) => void)("a")}>
          select-a
        </button>
        <button data-testid="left-select-b" onClick={() => (p.onSelectPost as (id: string) => void)("b")}>
          select-b
        </button>
        <button data-testid="left-newpost" onClick={() => (p.onNewPost as () => void)()}>
          new
        </button>
        <button data-testid="left-more-pub" onClick={() => (p.onLoadMore as (status: string) => void)("published")}>
          more-pub
        </button>
        <button data-testid="left-more-disc" onClick={() => (p.onLoadMore as (status: string) => void)("discarded")}>
          more-disc
        </button>
        <button data-testid="left-more-ret" onClick={() => (p.onLoadMore as (status: string) => void)("retired")}>
          more-ret
        </button>
        <button data-testid="left-settings" onClick={() => (p.onOpenSettings as () => void)()}>
          settings
        </button>
        <button data-testid="left-shortcuts" onClick={() => (p.onOpenShortcuts as () => void)()}>
          shortcuts
        </button>
        <button data-testid="left-about" onClick={() => (p.onOpenAbout as () => void)()}>
          about
        </button>
        <button data-testid="left-records" onClick={() => void (p.onOpenRecords as () => void)()}>
          records
        </button>
        <button data-testid="left-switch" onClick={() => (p.onSwitchWorkspace as () => void)()}>
          switch
        </button>
      </div>
    );
  },
}));

vi.mock("@renderer/components/CenterPane", () => {
  return {
    CenterPane: function MockCenter(p: AnyProps) {
      props.center = p;
      return (
        <div data-testid="center">
          <span data-testid="center-postid">{String(p.postId)}</span>
          <button
            data-testid="center-content"
            onClick={() => (p.onContentChange as (c: string) => void)("BODY")}
          >
            content
          </button>
          <button
            data-testid="center-loaded"
            onClick={() => (p.onPostLoaded as (post: Post) => void)(POST_A)}
          >
            loaded
          </button>
          <button
            data-testid="center-updated"
            onClick={() => (p.onPostUpdated as (r: PostMutationResult) => void)(MUTATION_A_VERIFIED)}
          >
            updated
          </button>
          <button
            data-testid="center-published"
            onClick={() => (p.onPostUpdated as (r: PostMutationResult) => void)(MUTATION_A_PUB)}
          >
            published
          </button>
          <button data-testid="center-deleted" onClick={() => (p.onPostDeleted as (id: string, result: { cleanupIncomplete: boolean }) => void)(p.postId as string, { cleanupIncomplete: false })}>
            deleted
          </button>
          <button data-testid="center-deleted-a" onClick={() => (p.onPostDeleted as (id: string, result: { cleanupIncomplete: boolean }) => void)("a", { cleanupIncomplete: true })}>
            delayed-delete-a
          </button>
          <button data-testid="center-export" onClick={() => (p.onExport as () => void)()}>
            export
          </button>
          <button
            data-testid="center-navigate"
            onClick={() => void (p.onSelectPost as (id: string) => void)("b")}
          >
            navigate-b
          </button>
          <button
            data-testid="center-before-status"
            onClick={() => void (p.onBeforeStatusChange as () => Promise<boolean>)?.()}
          >
            before-status
          </button>
          {p.onGoBack ? (
            <button data-testid="center-back" onClick={() => void (p.onGoBack as () => void)()}>
              back
            </button>
          ) : null}
        </div>
      );
    },
  };
});

vi.mock("@renderer/components/RightPane", () => {
  const { forwardRef, useImperativeHandle } = require("react") as typeof import("react");
  return {
    RightPane: forwardRef(function MockRight(p: AnyProps, ref: React.Ref<unknown>) {
      props.right = p;
      useImperativeHandle(ref, () => ({ flushPendingChanges: rightFlush }), []);
      return (
        <div data-testid="right">
          <span data-testid="right-postid">{String(p.postId)}</span>
          <span data-testid="right-tab">{String(p.activeTab)}</span>
          <span data-testid="right-content">{String(p.content)}</span>
          <span data-testid="right-loading">{String(p.loading)}</span>
          <span data-testid="right-trigger">{String(p.analysisTrigger)}</span>
          <span data-testid="right-prompts-version">{String(p.analysisPromptsVersion)}</span>
          <span data-testid="right-slug">{String((p.frontMatter as { slug?: string } | null)?.slug)}</span>
          <button
            data-testid="right-metadata-a"
            onClick={() =>
              (p.onMetadataEdited as (id: string, edits: { slug: string }) => void)("a", { slug: "edited-slug" })
            }
          >
            r-metadata-a
          </button>
          <button
            data-testid="right-metadata-b"
            onClick={() =>
              (p.onMetadataEdited as (id: string, edits: { slug: string }) => void)("b", { slug: "late-slug" })
            }
          >
            r-metadata-b
          </button>
          <button
            data-testid="right-insert"
            onClick={() => (p.onInsertAtCursor as (t: string) => void)("INSERTED")}
          >
            insert
          </button>
        </div>
      );
    }),
  };
});

function modalMock(testid: string) {
  return function MockModal(p: AnyProps) {
    const { useEffect, useRef } = require("react") as typeof import("react");
    const current = useRef(true);
    useEffect(() => () => { current.current = false; }, []);
    return <div data-testid={testid}>
      <button data-testid={`${testid}-close`} onClick={() => { current.current = false; (p.onClose as () => void)(); }}>close</button>
      {p.onCreate ? <button data-testid={`${testid}-create`} onClick={() =>
        void (p.onCreate as (t: string, l: string, s?: string, mayAdopt?: () => boolean) => void)("blog", "en", undefined, () => current.current)
      }>create</button> : null}
      {p.onSettingsChanged ? <button data-testid={`${testid}-changed`} onClick={() => (p.onSettingsChanged as () => void)()}>changed</button> : null}
      {p.onWorkspaceRenamed ? <button data-testid={`${testid}-renamed`} onClick={() =>
        (p.onWorkspaceRenamed as (ws: Workspace) => void)({ id: p.workspaceId as string, name: "Renamed", dataDirectory: p.workspaceFolder as string })
      }>{`${p.workspaceName as string} @ ${p.workspaceFolder as string}`}</button> : null}
    </div>;
  };
}

vi.mock("@renderer/components/ExportModal", () => ({ ExportModal: modalMock("export-modal") }));
vi.mock("@renderer/components/NewPostModal", () => ({ NewPostModal: modalMock("newpost-modal") }));
vi.mock("@renderer/components/SettingsModal", () => ({ SettingsModal: modalMock("settings-modal") }));
vi.mock("@renderer/components/ShortcutsModal", () => ({
  ShortcutsModal: modalMock("shortcuts-modal"),
}));
vi.mock("@renderer/components/AboutModal", () => ({ AboutModal: modalMock("about-modal") }));

import { WorkspaceSession, type WorkspaceSessionHandle } from "@renderer/WorkspaceSession";
import { listPosts, listPostPage, createPost, getWorkspaceConfig, getPost, openRecordsWindow } from "@renderer/api";

const mockListPosts = vi.mocked(listPosts);
const mockListPostPage = vi.mocked(listPostPage);
const mockCreatePost = vi.mocked(createPost);
const mockGetWorkspaceConfig = vi.mocked(getWorkspaceConfig);
const mockOpenRecords = vi.mocked(openRecordsWindow);
const mockGetPost = vi.mocked(getPost);


// --- Fixtures --------------------------------------------------------------

const WS: Workspace = { id: "ws1", name: "Alpha", dataDirectory: "/d/a" };

function fm(id: string, status: PostSummary["frontMatter"]["status"], extra: AnyProps = {}) {
  return {
    id,
    target: "blog",
    status,
    language: "en",
    createdAtUtc: "2026-01-01T00:00:00.000Z",
    ...extra,
  } as PostSummary["frontMatter"];
}

const summary = (id: string, status: PostSummary["frontMatter"]["status"], extra: AnyProps = {}) => ({
  frontMatter: fm(id, status, extra),
});

const LIST: PostListResponse = {
  draft: { posts: [summary("a", "draft"), summary("b", "draft")], total: 2, offset: 0 },
  discarded: { posts: [summary("x1", "discarded", { discardedAtUtc: "2026-02-15T00:00:00.000Z" })], total: 4, offset: 0 },
  verified: { posts: [summary("c", "verified")], total: 1, offset: 0 },
  published: { posts: [summary("p1", "published", { publishedAtUtc: "2026-02-01T00:00:00.000Z" })], total: 3, offset: 0 },
  retired: { posts: [summary("e1", "retired", { retiredAtUtc: "2026-03-01T00:00:00.000Z" })], total: 2, offset: 0 },
};

const FIRST = { discarded: 0, published: 0, retired: 0 };

const SETTINGS: Settings = {
  timezone: "America/New_York",
  supportedLanguages: ["en", "ja"],
  postsPerLoad: 25,
  editorWatermark: "WATER",
  extraFieldWatermark: "EXTRA",
  uiFontFamily: "",
  contentFont: DEFAULT_CONTENT_FONT,
};

const TARGETS: Target[] = [{ name: "blog", defaultLanguage: "en", requiresMetadata: true }];

const POST_A: Post = {
  frontMatter: fm("a", "draft"),
  content: "post a body",
};

const MUTATION_A_VERIFIED: PostMutationResult = {
  frontMatter: fm("a", "verified"),
  content: "post a body",
  summary: fm("a", "verified"),
};

const MUTATION_A_PUB: PostMutationResult = {
  frontMatter: fm("a", "published", { publishedAtUtc: "2026-04-01T00:00:00.000Z" }),
  content: "post a body",
  summary: fm("a", "published", { publishedAtUtc: "2026-04-01T00:00:00.000Z" }),
};

const POST_B_CREATED: Post = { frontMatter: fm("newid", "draft"), content: "" };

// --- Harness ---------------------------------------------------------------

function noopDrag() {}

function renderSession(ref?: React.Ref<WorkspaceSessionHandle>) {
  const appLayoutRef = { current: null } as React.RefObject<HTMLDivElement | null>;
  return render(
    <WorkspaceSession
      ref={ref}
      workspace={WS}
      appLayoutRef={appLayoutRef}
      leftWidth={360}
      rightWidth={480}
      onLeftWidthChange={vi.fn()}
      onRightWidthChange={vi.fn()}
      onLeftWidthCommit={vi.fn()}
      onRightWidthCommit={vi.fn()}
      onStartLeftDrag={noopDrag}
      onStartRightDrag={noopDrag}
      onSwitchWorkspace={onSwitchWorkspace}
      onWorkspaceUpdated={onWorkspaceUpdated}
    />
  );
}

const onSwitchWorkspace = vi.fn();
const onWorkspaceUpdated = vi.fn();

// Renders and flushes the load effect (listPosts + listTargets + getSettings).
async function mountLoaded(ref?: React.Ref<WorkspaceSessionHandle>) {
  const utils = renderSession(ref);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

beforeEach(() => {
  anyModalOpen = false;
  mockListPosts.mockReset().mockResolvedValue(LIST);
  mockListPostPage.mockReset().mockResolvedValue(LIST.published);
  mockGetPost.mockReset().mockResolvedValue(POST_A);
  mockCreatePost.mockReset().mockResolvedValue(POST_B_CREATED);
  mockGetWorkspaceConfig.mockReset().mockResolvedValue({ targets: TARGETS, settings: SETTINGS, notice: null });
  mockOpenRecords.mockReset().mockResolvedValue();
  rightFlush.mockReset().mockResolvedValue(true);
  insertAtCursor.mockReset();
  onSwitchWorkspace.mockReset();
  onWorkspaceUpdated.mockReset();
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--bm-font-ui");
});

describe("WorkspaceSession initial load", () => {
  it("loads posts and config and feeds the left pane", async () => {
    const { getByTestId } = await mountLoaded();

    // The load effect re-runs once after settings lands a new postsPerLoad
    // (loadPosts closes over pubBatchSize), so posts may load more than once; what
    // matters is that each loader ran and the panes received the data.
    expect(mockListPosts).toHaveBeenCalled();
    expect(mockGetWorkspaceConfig).toHaveBeenCalled();

    expect(getByTestId("left-drafts").textContent).toBe("a,b");
    expect(getByTestId("left-discarded").textContent).toBe("x1");
    expect(getByTestId("left-verified").textContent).toBe("c");
    expect(getByTestId("left-published").textContent).toBe("p1");
    expect(getByTestId("left-retired").textContent).toBe("e1");
    expect(getByTestId("left-published-total").textContent).toBe("3");
    expect(getByTestId("left-retired-total").textContent).toBe("2");
    expect(getByTestId("left-ws-name").textContent).toBe("Alpha");
    // The settings timezone is valid, so it overrides the default.
    expect(getByTestId("left-timezone").textContent).toBe("America/New_York");
  });

  it("says when stored settings could not be used, until dismissed", async () => {
    mockGetWorkspaceConfig.mockResolvedValue({ targets: TARGETS, settings: SETTINGS, notice: { key: "session.settingsInvalid", values: { path: "/d/a/config.json" } } });
    const { container, getByText } = await mountLoaded();
    const notice = getByText(/Some settings saved in \/d\/a\/config.json could not be used/);
    expect(notice).toBeTruthy();
    fireEvent.click(container.querySelector(".toolbar-warning button")!);
    expect(container.querySelector(".toolbar-warning")).toBeNull();
  });

  it("shows times in the computer's zone when the workspace follows System", async () => {
    mockGetWorkspaceConfig.mockResolvedValue({ targets: TARGETS, settings: { ...SETTINGS, timezone: "system" }, notice: null });
    const { getByTestId } = await mountLoaded();
    // The renderer project pins TZ to Asia/Tokyo.
    expect(getByTestId("left-timezone").textContent).toBe("Asia/Tokyo");
  });

  it("shows the empty center until a post is selected", async () => {
    const { getByText, queryByTestId } = await mountLoaded();
    expect(getByText("Select a post or create a new one")).toBeTruthy();
    expect(queryByTestId("center")).toBeNull();
    expect(queryByTestId("right")).toBeNull();
  });

  it("surfaces a load failure in the toolbar and dismisses it", async () => {
    mockListPosts.mockRejectedValue(new Error("disk gone"));
    const { getByText, container, queryByText } = await mountLoaded();
    expect(getByText("This workspace could not be loaded. Reopen it to try again.")).toBeTruthy();

    fireEvent.click(container.querySelector(".toolbar-error-dismiss")!);
    expect(queryByText("This workspace could not be loaded. Reopen it to try again.")).toBeNull();
  });

  it("names the post files the list left out, until dismissed or the set changes", async () => {
    const broken = "/d/a/posts/20260101-000000-utc-broken.md";
    const newer = "/d/a/posts/20260101-000001-utc-newer.md";
    mockListPosts.mockResolvedValue({ ...LIST, unreadable: [{ path: broken, newer: false }, { path: newer, newer: true }] });
    const { getByText, container, queryByText } = await mountLoaded();

    expect(getByText("2 post files are not in the list because BigMouth could not read them:")).toBeTruthy();
    expect(getByText(`BigMouth could not read ${broken}, so the file was left unchanged. Repair or move it, then try again.`)).toBeTruthy();
    expect(getByText(`A newer version of BigMouth saved ${newer}, so this version cannot use it. The file was left unchanged; open it with that version.`)).toBeTruthy();
    expect(container.querySelector(".toolbar-warning")).toBeTruthy();

    fireEvent.click(container.querySelector(".toolbar-warning .operational-result-dismiss")!);
    expect(queryByText(/post files are not in the list/)).toBeNull();
  });

  // One banner however many files: a few final segments, a count of the rest,
  // and every whole path behind the disclosure, so the banner stays short.
  it("names three unreadable files by their final segment and counts the rest", async () => {
    const paths = Array.from({ length: 6 }, (_, index) => `/d/a/posts/2026010${index}-000000-utc-file.md`);
    mockListPosts.mockResolvedValue({ ...LIST, unreadable: paths.map((path) => ({ path, newer: false })) });
    const { container } = await mountLoaded();

    const banner = container.querySelector(".toolbar-warning") as HTMLElement;
    expect(banner.querySelector(".named-items-summary")?.textContent).toBe(
      "20260100-000000-utc-file.md, 20260101-000000-utc-file.md, 20260102-000000-utc-file.md and 3 more",
    );
    const listed = [...banner.querySelectorAll(".named-items-list li")].map((item) => item.textContent);
    expect(listed).toHaveLength(6);
    expect(listed[5]).toContain(paths[5]);
  });

  it("cannot apply a workspace font after the session unmounts", async () => {
    let resolveSettings!: (settings: WorkspaceConfigView) => void;
    mockGetWorkspaceConfig.mockReturnValue(
      new Promise<WorkspaceConfigView>((resolve) => {
        resolveSettings = resolve;
      }),
    );
    document.documentElement.style.setProperty("--bm-font-ui", "Baseline");
    const { unmount } = renderSession();
    unmount();

    await act(async () => {
      resolveSettings({ targets: TARGETS, settings: { ...SETTINGS, uiFontFamily: "Late Font" }, notice: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.documentElement.style.getPropertyValue("--bm-font-ui")).toBe("Baseline");
  });
});

describe("WorkspaceSession post selection", () => {
  it("opens the center/right panes for the selected post", async () => {
    const { getByTestId, queryByText } = await mountLoaded();

    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });

    // The first selection has no open post to flush (the panes aren't mounted
    // yet), so it just opens the panes for "a".
    expect(getByTestId("center-postid").textContent).toBe("a");
    expect(getByTestId("right-postid").textContent).toBe("a");
    expect(getByTestId("left-selected").textContent).toBe("a");
    expect(queryByText("Select a post or create a new one")).toBeNull();
  });

  it("flushes the open post's panes before switching to another", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    rightFlush.mockClear();
    // Switching away from an open post flushes its metadata pane first; content
    // needs no renderer flush — it streams to the main-process saver as typed.
    await act(async () => {
      fireEvent.click(getByTestId("left-select-b"));
      await Promise.resolve();
    });
    expect(rightFlush).toHaveBeenCalled();
    expect(getByTestId("center-postid").textContent).toBe("b");
  });

  it("reports the post as loading until the full post arrives, then clears", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    // currentPost is null right after selecting, so the right pane is loading.
    expect(getByTestId("right-loading").textContent).toBe("true");

    act(() => {
      fireEvent.click(getByTestId("center-loaded")); // onPostLoaded(POST_A)
    });
    expect(getByTestId("right-loading").textContent).toBe("false");
  });

  it("threads editor content from the center pane into the right pane", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    act(() => {
      fireEvent.click(getByTestId("center-content")); // onContentChange("BODY")
    });
    expect(getByTestId("right-content").textContent).toBe("BODY");
  });

  it("does not re-flush when re-selecting the already-open post", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    rightFlush.mockClear();
    // Re-selecting the same id short-circuits before flushing.
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    expect(rightFlush).not.toHaveBeenCalled();
  });

  it("keeps the current post when the flush refuses on a switch", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    rightFlush.mockResolvedValue(false); // dirty metadata + save failed → block the switch
    await act(async () => {
      fireEvent.click(getByTestId("left-select-b"));
      await Promise.resolve();
    });
    // The switch was vetoed; post "a" is still open.
    expect(getByTestId("center-postid").textContent).toBe("a");
  });
});

describe("WorkspaceSession post mutation", () => {
  it("applies a status change from the center pane to the lists and editor", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    act(() => {
      fireEvent.click(getByTestId("center-updated")); // a: draft -> verified
    });
    // "a" moved out of drafts into verified. "a" and "c" share a createdAtUtc, so the
    // tie is stable and "a" appends after the existing "c".
    expect(getByTestId("left-drafts").textContent).toBe("b");
    expect(getByTestId("left-verified").textContent).toBe("c,a");
  });

  it("applies a status change to published", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    act(() => {
      fireEvent.click(getByTestId("center-published")); // a: draft -> published
    });
    expect(getByTestId("left-drafts").textContent).toBe("b");
    expect(getByTestId("left-published").textContent).toBe("a,p1");
    // publishedTotal incremented for the newly published post.
    expect(getByTestId("left-published-total").textContent).toBe("4");
  });

  it("folds a buffered metadata edit into the open post, and only into its own post", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    act(() => {
      fireEvent.click(getByTestId("center-loaded")); // onPostLoaded(POST_A)
    });

    act(() => {
      fireEvent.click(getByTestId("right-metadata-b")); // a late reply for another post
    });
    expect(getByTestId("right-slug").textContent).toBe("undefined");

    act(() => {
      fireEvent.click(getByTestId("right-metadata-a"));
    });
    expect(getByTestId("right-slug").textContent).toBe("edited-slug");
  });

  it("removes the submitted deleted post without moving a newer selection", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => { fireEvent.click(getByTestId("left-select-b")); });
    await act(async () => { fireEvent.click(getByTestId("center-deleted-a")); });
    expect(getByTestId("left-drafts").textContent).toBe("b");
    expect(getByTestId("center-postid").textContent).toBe("b");
    expect(document.body.textContent).toContain("The post was deleted, but some source links or attachments could not be removed.");
  });

  it("removes a deleted post and selects its neighbour", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(getByTestId("center-deleted"));
      await Promise.resolve();
    });
    // "a" is gone from drafts; its neighbour "b" becomes the selection.
    expect(getByTestId("left-drafts").textContent).toBe("b");
    expect(getByTestId("center-postid").textContent).toBe("b");
  });
});

describe("WorkspaceSession new post", () => {
  it("creates, reloads, and selects the new post", async () => {
    const { getByTestId } = await mountLoaded();
    fireEvent.click(getByTestId("left-newpost"));
    expect(getByTestId("newpost-modal")).toBeTruthy();

    await act(async () => {
      fireEvent.click(getByTestId("newpost-modal-create"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCreatePost).toHaveBeenCalledWith("blog", "en", undefined, WS.id);
    // The modal closed, posts reloaded, and the new post is selected/open.
    expect(getByTestId("center-postid").textContent).toBe("newid");
  });
});

describe("WorkspaceSession navigation", () => {
  it("pushes the previous post onto the back stack and pops it on Back", async () => {
    const { getByTestId, queryByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    // No back affordance yet (empty history).
    expect(queryByTestId("center-back")).toBeNull();

    await act(async () => {
      fireEvent.click(getByTestId("center-navigate")); // navigate a -> b, push "a"
      await Promise.resolve();
    });
    expect(getByTestId("center-postid").textContent).toBe("b");
    // History now has "a", so Back is offered.
    expect(getByTestId("center-back")).toBeTruthy();

    await act(async () => {
      fireEvent.click(getByTestId("center-back")); // back to "a"
      await Promise.resolve();
    });
    expect(getByTestId("center-postid").textContent).toBe("a");
    // History emptied again.
    expect(queryByTestId("center-back")).toBeNull();
  });

  it("clears the back stack when picking a post from the left list", async () => {
    const { getByTestId, queryByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(getByTestId("center-navigate")); // push "a"
      await Promise.resolve();
    });
    expect(getByTestId("center-back")).toBeTruthy();
    // A fresh left-list selection resets navigation history.
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    expect(queryByTestId("center-back")).toBeNull();
  });
});

describe("WorkspaceSession modals", () => {
  it("opens and closes the settings modal, reloading config on change", async () => {
    const { getByTestId, queryByTestId } = await mountLoaded();
    fireEvent.click(getByTestId("left-settings"));
    expect(getByTestId("settings-modal")).toBeTruthy();

    mockGetWorkspaceConfig.mockClear();
    mockListPosts.mockClear();
    rightFlush.mockClear();
    await act(async () => {
      fireEvent.click(getByTestId("settings-modal-changed"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // onSettingsChanged reloads targets + settings — and the POSTS with them.
    // Renaming a target rewrites `target` in every post file, so reloading only
    // the targets left the open post carrying a name that matched nothing: the
    // Metadata tab vanished. Reloading the post keeps its target projection current.
    expect(mockGetWorkspaceConfig).toHaveBeenCalledTimes(1);
    expect(mockListPosts).toHaveBeenCalledTimes(1);
    // The analysis prompts version bumps so the right pane reloads prompts. (It
    // is only mounted with a post open, so we just assert the modal cycle here.)
    fireEvent.click(getByTestId("settings-modal-close"));
    expect(queryByTestId("settings-modal")).toBeNull();
  });

  it("gives Settings the workspace's name and folder and reports its rename to the app", async () => {
    const { getByTestId } = await mountLoaded();
    fireEvent.click(getByTestId("left-settings"));
    const renamed = getByTestId("settings-modal-renamed");
    expect(renamed.textContent).toBe("Alpha @ /d/a");

    fireEvent.click(renamed);
    expect(onWorkspaceUpdated).toHaveBeenCalledExactlyOnceWith({ id: "ws1", name: "Renamed", dataDirectory: "/d/a" });
  });

  it("hands the open post, reread after a settings change, to the centre pane", async () => {
    // A target rename rewrites `target` in every post file; the centre toolbar
    // shows the pane's own copy, so the reread must reach the pane too.
    const reread: Post = { frontMatter: fm("a", "draft", { target: "renamed" }), content: "on disk" };
    mockGetPost.mockReset().mockResolvedValue(reread);
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    expect(props.center!.rereadPost).toBeNull();

    fireEvent.click(getByTestId("left-settings"));
    await act(async () => {
      fireEvent.click(getByTestId("settings-modal-changed"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockGetPost).toHaveBeenCalledWith("a", WS.id);
    expect(props.center!.rereadPost).toBe(reread);
  });

  it("flushes pending metadata edits before a settings change lands", async () => {
    // The right pane is only mounted with a post open, which is exactly the case
    // that loses data: renaming a target can make the Metadata tab disappear, and
    // its unmount must not discard a refused value without the save/discard decision.
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    fireEvent.click(getByTestId("left-settings"));
    rightFlush.mockClear();

    await act(async () => {
      fireEvent.click(getByTestId("settings-modal-changed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rightFlush).toHaveBeenCalled();
  });

  it("does not reload settings when pending metadata cannot be saved", async () => {
    const { getByTestId, getByText } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    fireEvent.click(getByTestId("left-settings"));
    mockGetWorkspaceConfig.mockClear();
    mockListPosts.mockClear();
    rightFlush.mockReset().mockResolvedValue(false);

    await act(async () => {
      fireEvent.click(getByTestId("settings-modal-changed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByText(/Metadata changes could not be saved/)).toBeTruthy();
    expect(mockGetWorkspaceConfig).not.toHaveBeenCalled();
    expect(mockListPosts).not.toHaveBeenCalled();
  });

  it("opens and closes the shortcuts and about modals", async () => {
    const { getByTestId, queryByTestId } = await mountLoaded();
    fireEvent.click(getByTestId("left-shortcuts"));
    expect(getByTestId("shortcuts-modal")).toBeTruthy();
    fireEvent.click(getByTestId("shortcuts-modal-close"));
    expect(queryByTestId("shortcuts-modal")).toBeNull();

    fireEvent.click(getByTestId("left-about"));
    expect(getByTestId("about-modal")).toBeTruthy();
    fireEvent.click(getByTestId("about-modal-close"));
    expect(queryByTestId("about-modal")).toBeNull();
  });

  it("opens the export modal from the center pane only with a post open", async () => {
    const { getByTestId, queryByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    fireEvent.click(getByTestId("center-export"));
    expect(getByTestId("export-modal")).toBeTruthy();
    fireEvent.click(getByTestId("export-modal-close"));
    expect(queryByTestId("export-modal")).toBeNull();
  });
});

describe("WorkspaceSession load more / log", () => {
  it("claims a page before waiting and drops it when a newer post mutation changes its basis", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => { fireEvent.click(getByTestId("left-select-a")); });
    mockListPosts.mockClear();
    mockListPostPage.mockClear();
    let answer!: (response: PostPageResponse) => void;
    mockListPostPage.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    try {
      act(() => {
        fireEvent.click(getByTestId("left-more-pub"));
        fireEvent.click(getByTestId("left-more-pub"));
      });
      expect(mockListPostPage).toHaveBeenCalledTimes(1);
      expect(mockListPosts).not.toHaveBeenCalled();
      act(() => { fireEvent.click(getByTestId("center-published")); });
    } finally {
      await act(async () => {
        answer({ posts: [summary("p2", "published")], total: 3, offset: 1 });
      });
    }
    expect(getByTestId("left-published").textContent).toBe("a,p1");
    expect(getByTestId("left-published-total").textContent).toBe("4");
    expect(getByTestId("left-drafts").textContent).toBe("b");
  });

  it("loads the next published page, appending it", async () => {
    const { getByTestId } = await mountLoaded();
    mockListPosts.mockClear();
    mockListPostPage.mockClear();
    const page2: PostPageResponse = {
      posts: [summary("p2", "published", { publishedAtUtc: "2026-01-15T00:00:00.000Z" })], total: 3, offset: 1,
    };
    mockListPostPage.mockResolvedValue(page2);
    await act(async () => {
      fireEvent.click(getByTestId("left-more-pub"));
      await Promise.resolve();
    });
    // Appended: original page plus the next; the other paged sections untouched.
    expect(getByTestId("left-published").textContent).toBe("p1,p2");
    expect(getByTestId("left-discarded").textContent).toBe("x1");
    expect(mockListPostPage).toHaveBeenCalledExactlyOnceWith("published", 1, 25, WS.id);
    expect(mockListPosts).not.toHaveBeenCalled();
    expect(getByTestId("left-drafts").textContent).toBe("a,b");
    expect(getByTestId("left-verified").textContent).toBe("c");
  });

  it("loads the next discarded page from its own offset", async () => {
    const { getByTestId } = await mountLoaded();
    mockListPosts.mockClear();
    mockListPostPage.mockClear();
    mockListPostPage.mockResolvedValue({
      posts: [summary("x2", "discarded", { discardedAtUtc: "2026-01-01T00:00:00.000Z" })], total: 4, offset: 1,
    });
    await act(async () => {
      fireEvent.click(getByTestId("left-more-disc"));
      await Promise.resolve();
    });
    expect(getByTestId("left-discarded").textContent).toBe("x1,x2");
    expect(getByTestId("left-published").textContent).toBe("p1");
    expect(mockListPostPage).toHaveBeenCalledExactlyOnceWith("discarded", 1, 25, WS.id);
    expect(mockListPosts).not.toHaveBeenCalled();
  });

  it("surfaces a load-more failure", async () => {
    const { getByTestId, getByText } = await mountLoaded();
    mockListPostPage.mockRejectedValue(new Error("more failed"));
    await act(async () => {
      fireEvent.click(getByTestId("left-more-ret"));
      await Promise.resolve();
    });
    expect(getByText("More retired posts could not be loaded. The posts already shown are unchanged; try again.")).toBeTruthy();
  });

  it("opens the records window and surfaces a failure", async () => {
    const { getByTestId, getByText } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-records"));
      await Promise.resolve();
    });
    expect(mockOpenRecords).toHaveBeenCalledTimes(1);

    mockOpenRecords.mockRejectedValue(new Error("no window"));
    await act(async () => {
      fireEvent.click(getByTestId("left-records"));
      await Promise.resolve();
    });
    expect(getByText("The records window could not be opened. Try again.")).toBeTruthy();
  });
});

// Post files edited on disk outside the app (git, another editor) show once the
// window comes back to the front.
describe("WorkspaceSession reread on activation", () => {
  const activate = () => activationListeners.forEach((listener) => listener());
  const EDITED: PostListResponse = {
    ...LIST,
    draft: { posts: [summary("b", "draft"), summary("x", "draft")], total: 2, offset: 0 },
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function settle(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("rereads the list once for activations in quick succession", async () => {
    const { getByTestId } = await mountLoaded();
    mockListPosts.mockClear().mockResolvedValue(EDITED);

    act(() => {
      activate();
      activate();
    });
    await settle(200);
    act(() => activate());
    await settle(299);
    expect(mockListPosts).not.toHaveBeenCalled();
    await settle(1);

    expect(mockListPosts).toHaveBeenCalledTimes(1);
    expect(getByTestId("left-drafts").textContent).toBe("b,x");
  });

  it("keeps as many published posts loaded as were shown", async () => {
    const { getByTestId } = await mountLoaded();
    mockListPostPage.mockResolvedValueOnce({ posts: [summary("p2", "published")], total: 3, offset: 1 });
    await act(async () => {
      fireEvent.click(getByTestId("left-more-pub"));
      await Promise.resolve();
    });
    mockListPosts.mockClear().mockResolvedValue(LIST);

    act(() => activate());
    await settle(300);

    // The batch size is 25, more than any paged section shows, so a page of it is read.
    expect(mockListPosts).toHaveBeenCalledExactlyOnceWith(FIRST, 25, WS.id);
  });

  it("drops a reread the app's own list change overtook", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    let answer!: (list: PostListResponse) => void;
    mockListPosts.mockClear().mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

    act(() => activate());
    await settle(300);
    act(() => {
      fireEvent.click(getByTestId("center-updated")); // a: draft -> verified, while the read is out
    });
    await act(async () => answer(LIST));

    expect(getByTestId("left-drafts").textContent).toBe("b");
    expect(getByTestId("left-verified").textContent).toBe("c,a");
  });

  it("refreshes open-post facts while retaining typed body text", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    act(() => {
      fireEvent.click(getByTestId("center-loaded"));
      fireEvent.click(getByTestId("center-content"));
    });
    const frontMatter = props.right?.frontMatter;
    expect(frontMatter).toBe(POST_A.frontMatter);
    const external = { ...POST_A, frontMatter: { ...POST_A.frontMatter, locked: true, target: "outside", status: "verified" as const } };
    mockGetPost.mockResolvedValueOnce(external);
    mockListPosts.mockClear().mockResolvedValue(EDITED);

    act(() => activate());
    await settle(300);

    expect(mockListPosts).toHaveBeenCalledTimes(1);
    expect(getByTestId("center-postid").textContent).toBe("a");
    expect(props.right?.frontMatter).toBe(external.frontMatter);
    expect(props.center?.rereadPost).toBe(external);
    expect(props.right?.content).toBe("BODY");
  });

  it("keeps an accepted metadata edit made during refresh while applying an external lock", async () => {
    const view = await mountLoaded();
    await act(async () => { fireEvent.click(view.getByTestId("left-select-a")); });
    fireEvent.click(view.getByTestId("center-loaded"));
    let finish!: (post: Post) => void;
    mockGetPost.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    act(() => activate());
    await settle(300);
    act(() => (props.right!.onMetadataEdited as (id: string, edits: EditablePostMetadata) => void)("a", { title: "typed during read" }));
    await act(async () => finish({ ...POST_A, frontMatter: { ...POST_A.frontMatter, locked: true, title: "older title" } }));
    expect(props.right!.frontMatter).toMatchObject({ locked: true, title: "typed during read" });
    expect((props.center!.rereadPost as Post).frontMatter).toMatchObject({ locked: true, title: "typed during read" });
  });

  it("does not let an older refresh replace a mutation or a different selection", async () => {
    const view = await mountLoaded();
    await act(async () => { fireEvent.click(view.getByTestId("left-select-a")); });
    fireEvent.click(view.getByTestId("center-loaded"));
    let finish!: (post: Post) => void;
    mockGetPost.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    act(() => activate());
    await settle(300);
    fireEvent.click(view.getByTestId("center-updated"));
    await act(async () => finish(POST_A));
    expect((props.right!.frontMatter as PostFrontMatter).status).toBe("verified");
    mockGetPost.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    act(() => activate());
    await settle(300);
    await act(async () => { fireEvent.click(view.getByTestId("left-select-b")); });
    await act(async () => finish(POST_A));
    expect(props.center!.postId).toBe("b");
    expect(props.center!.rereadPost).toBeNull();
    expect(props.right!.frontMatter).toBeNull();
  });

  it("surfaces a failed reread and stops listening once the session closes", async () => {
    const { getByText, unmount } = await mountLoaded();
    mockListPosts.mockClear().mockRejectedValue(new Error("disk gone"));
    act(() => activate());
    await settle(300);
    expect(getByText("The workspace could not be refreshed. Reopen it to try again.")).toBeTruthy();

    unmount();
    expect(activationListeners.size).toBe(0);
  });
});

describe("WorkspaceSession keyboard shortcuts", () => {
  function chord(key: string, target: Element | Document = document.body) {
    fireEvent.keyDown(target, { key, metaKey: true });
  }

  // The window-level handler owns every group but the workspace list's, whose
  // chords the list's own handler matches.
  it("acts on exactly the shortcut table's chords", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    // The loaded post's target asks for Metadata, so every tab chord can act.
    act(() => fireEvent.click(getByTestId("center-loaded")));
    const handled = SHORTCUT_GROUPS.filter((group) => group.title !== "shortcuts.groupWorkspaces").flatMap(
      (group) => group.shortcuts,
    );
    const tableKeys = handled.flatMap((shortcut) =>
      shortcut.chords.flat().flatMap((c) => (c.shiftedKey ? [c.key, c.shiftedKey] : [c.key])),
    );
    const keys = [...new Set([...tableKeys, ...tableKeys.map((k) => k.toUpperCase()), "6", "r", "w", "F2", "Delete", "Escape"])];
    const holds = [
      {},
      { metaKey: true },
      { ctrlKey: true },
      { metaKey: true, shiftKey: true },
      { metaKey: true, altKey: true },
      { ctrlKey: true, altKey: true },
      { shiftKey: true },
    ];
    for (const key of keys) {
      for (const held of holds) {
        const event = { key, ...held };
        let acted = false;
        act(() => {
          acted = !fireEvent.keyDown(document.body, event);
        });
        expect(acted, JSON.stringify(event)).toBe(handled.some((shortcut) => matchesShortcut(shortcut, event)));
      }
    }
  });

  it("Cmd+, opens settings and Cmd+/ opens shortcuts", async () => {
    const { getByTestId } = await mountLoaded();
    act(() => chord(","));
    expect(getByTestId("settings-modal")).toBeTruthy();
  });

  it("Cmd+/ opens the shortcuts reference", async () => {
    const { getByTestId } = await mountLoaded();
    act(() => chord("/"));
    expect(getByTestId("shortcuts-modal")).toBeTruthy();
  });

  it("Cmd+N opens the new-post dialog", async () => {
    const { getByTestId } = await mountLoaded();
    act(() => chord("n"));
    expect(getByTestId("newpost-modal")).toBeTruthy();
  });

  it("Cmd+number switches the right tab once a post is open", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    act(() => chord("3")); // Assets
    expect(getByTestId("right-tab").textContent).toBe("Assets");
  });

  it("Cmd+Enter focuses Analysis and bumps the analysis trigger", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    const before = Number(getByTestId("right-trigger").textContent);
    act(() => chord("Enter"));
    expect(getByTestId("right-tab").textContent).toBe("Analysis");
    expect(Number(getByTestId("right-trigger").textContent)).toBe(before + 1);
  });

  it("Cmd+E opens export when a post is selected", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    act(() => chord("e"));
    expect(getByTestId("export-modal")).toBeTruthy();
  });

  it("ignores a tab chord while no post is selected", async () => {
    const { getByTestId } = await mountLoaded();
    // No post open, so Cmd+2 must not change anything (right pane isn't mounted).
    act(() => chord("2"));
    expect(getByTestId("left-selected").textContent).toBe("");
  });

  it("stands down while a modal owns the keyboard", async () => {
    anyModalOpen = true;
    const { queryByTestId } = await mountLoaded();
    act(() => chord("n"));
    // The shortcut handler never registered, so Cmd+N does nothing.
    expect(queryByTestId("newpost-modal")).toBeNull();
  });

  it("ignores a non-modifier key", async () => {
    const { queryByTestId } = await mountLoaded();
    act(() => fireEvent.keyDown(document.body, { key: "n" })); // no meta/ctrl
    expect(queryByTestId("newpost-modal")).toBeNull();
  });

  it("ignores an IME-composing chord", async () => {
    const { queryByTestId } = await mountLoaded();
    act(() => fireEvent.keyDown(document.body, { key: "n", metaKey: true, isComposing: true }));
    expect(queryByTestId("newpost-modal")).toBeNull();
  });

  // These chords act inside text fields, where the user is while writing - the
  // editor's event target is a DIV inside its contenteditable - and the
  // shortcuts dialog lists them unconditionally. None of them shadows a
  // text-field binding a web view actually implements.
  it.each([
    ["a TEXTAREA", () => document.createElement("textarea")],
    ["an INPUT", () => document.createElement("input")],
    ["the markdown editor's contenteditable", () => {
      // jsdom implements neither the contentEditable setter nor
      // isContentEditable, so the flag has to be defined outright — without it
      // isEditableTarget's parentElement walk returns false and this case
      // asserts nothing at all.
      const host = document.createElement("div");
      Object.defineProperty(host, "isContentEditable", { value: true });
      const inner = document.createElement("div");
      host.appendChild(inner);
      return host;
    }],
  ])("opens new-post from %s", async (_name, make) => {
    const { getByTestId } = await mountLoaded();
    const host = make();
    document.body.appendChild(host);

    act(() => chord("n", host.lastElementChild ?? host));

    expect(getByTestId("newpost-modal")).toBeTruthy();
    host.remove();
  });

  // The one rule that genuinely bites: on macOS Ctrl inside a text field
  // belongs to the text system whatever the key is. jsdom reports no platform,
  // so each case supplies its own; reading the running one would take the
  // non-Mac branch everywhere.
  it.each([
    ["macOS", "MacIntel", false],
    ["Windows", "Win32", true],
  ])("on %s, Ctrl+N inside a text field opens New Post: %s", async (_name, platform, opens) => {
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
    try {
      const { queryByTestId } = await mountLoaded();
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);

      act(() => {
        fireEvent.keyDown(textarea, { key: "n", ctrlKey: true });
      });

      expect(queryByTestId("newpost-modal") !== null).toBe(opens);
      textarea.remove();
    } finally {
      delete (navigator as { platform?: string }).platform;
    }
  });

  it("opens New Post on macOS from Cmd+N inside a text field", async () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      const { queryByTestId } = await mountLoaded();
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);

      act(() => {
        fireEvent.keyDown(textarea, { key: "n", metaKey: true });
      });

      expect(queryByTestId("newpost-modal")).toBeTruthy();
      textarea.remove();
    } finally {
      delete (navigator as { platform?: string }).platform;
    }
  });
});

// The session's async paths call setState without checking that it is still
// mounted. That needs no guard: App mounts this component with
// key={workspace.id}, so a switch is a full remount with fresh state and fresh
// refs, and since React 18 a setState after unmount is a silent no-op rather
// than a warning. This asserts it.
describe("a load that outlives the session", () => {
  it("settles after unmount without throwing or warning", async () => {
    let resolveList: (value: PostListResponse) => void = () => {};
    mockListPosts.mockReturnValueOnce(
      new Promise<PostListResponse>((resolve) => {
        resolveList = resolve;
      }),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderSession();
    unmount();

    await act(async () => {
      resolveList(LIST);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("WorkspaceSession imperative flush handle", () => {
  it("exposes flushPendingChanges that flushes the metadata pane", async () => {
    const ref = { current: null } as React.RefObject<WorkspaceSessionHandle | null>;
    const { getByTestId } = await mountLoaded(ref as React.Ref<WorkspaceSessionHandle>);
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    rightFlush.mockClear();

    let result: boolean | undefined;
    await act(async () => {
      result = await ref.current!.flushPendingChanges();
    });
    expect(result).toBe(true);
    expect(rightFlush).toHaveBeenCalled();
  });

  it("returns false when a pane refuses to flush", async () => {
    const ref = { current: null } as React.RefObject<WorkspaceSessionHandle | null>;
    const { getByTestId } = await mountLoaded(ref as React.Ref<WorkspaceSessionHandle>);
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    rightFlush.mockResolvedValue(false);
    let result: boolean | undefined;
    await act(async () => {
      result = await ref.current!.flushPendingChanges();
    });
    expect(result).toBe(false);
  });
});

describe("WorkspaceSession misc wiring", () => {
  it("forwards onSwitchWorkspace and onInsertAtCursor", async () => {
    const { getByTestId } = await mountLoaded();
    fireEvent.click(getByTestId("left-switch"));
    expect(onSwitchWorkspace).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    // onInsertAtCursor forwards to the editor ref; with the real editor mocked
    // out the ref is null, so this just exercises the callback without throwing.
    expect(() => fireEvent.click(getByTestId("right-insert"))).not.toThrow();
  });

  it("runs the right pane's pre-status-change flush hook", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    rightFlush.mockClear();
    await act(async () => {
      fireEvent.click(getByTestId("center-before-status"));
      await Promise.resolve();
    });
    expect(rightFlush).toHaveBeenCalled();
  });
});


it("does not select a delayed creation or close a reopened New Post modal", async () => {
  let finish!: (post: Post) => void;
  mockCreatePost.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = await mountLoaded();
  await act(async () => { fireEvent.click(view.getByTestId("left-select-a")); });
  fireEvent.click(view.getByTestId("left-newpost"));
  fireEvent.click(view.getByTestId("newpost-modal-create"));
  fireEvent.click(view.getByTestId("newpost-modal-close"));
  await act(async () => { fireEvent.click(view.getByTestId("left-select-b")); });
  fireEvent.click(view.getByTestId("left-newpost"));
  await act(async () => { finish(POST_B_CREATED); });
  expect(view.getByTestId("newpost-modal")).toBeTruthy();
  expect(view.getByTestId("center-postid").textContent).toBe("b");
  expect(mockCreatePost).toHaveBeenCalledExactlyOnceWith("blog", "en", undefined, WS.id);
});

it("does not start continuation reads after the creation's workspace session has left", async () => {
  let finish!: (post: Post) => void;
  mockCreatePost.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = await mountLoaded();
  fireEvent.click(view.getByTestId("left-newpost"));
  fireEvent.click(view.getByTestId("newpost-modal-create"));
  const reads = mockListPosts.mock.calls.length;
  view.unmount();
  await act(async () => { finish(POST_B_CREATED); });
  expect(mockListPosts).toHaveBeenCalledTimes(reads);
});

it("renders named focusable separators with each pane's displayed width and configured bounds", async () => {
  const view = await mountLoaded();
  const left = view.getByRole("separator", { name: "Resize the post list" });
  expect(left.tabIndex).toBe(0);
  expect(left.getAttribute("aria-orientation")).toBe("vertical");
  expect(left.getAttribute("aria-valuemin")).toBe(String(LEFT_MIN));
  expect(left.getAttribute("aria-valuemax")).toBe(String(LEFT_MAX));
  expect(left.getAttribute("aria-valuenow")).toBe("360");
  fireEvent.click(view.getByTestId("left-select-a"));
  await act(async () => { await Promise.resolve(); });
  const right = view.getByRole("separator", { name: "Resize the tools pane" });
  expect(right.tabIndex).toBe(0);
  expect(right.getAttribute("aria-orientation")).toBe("vertical");
  expect(right.getAttribute("aria-valuemin")).toBe(String(RIGHT_MIN));
  expect(right.getAttribute("aria-valuemax")).toBe(String(RIGHT_MAX));
  expect(right.getAttribute("aria-valuenow")).toBe("480");
});
