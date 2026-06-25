import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type {
  Post,
  PostListResponse,
  PostMutationResult,
  PostSummary,
  Settings,
  Target,
  Workspace,
} from "@shared/types";

// WorkspaceSession is the session orchestrator. It reaches the main process only
// through these five api calls; everything else it owns is state, routing, and
// the callbacks it threads down to the panes.
vi.mock("@renderer/api", () => ({
  listPosts: vi.fn(),
  createPost: vi.fn(),
  listTargets: vi.fn(),
  getSettings: vi.fn(),
  revealCurrentLogFile: vi.fn(),
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

const centerFlush = vi.fn<() => Promise<boolean>>();
const rightFlush = vi.fn<() => Promise<boolean>>();
const insertAtCursor = vi.fn();

vi.mock("@renderer/components/LeftPane", () => ({
  LeftPane: (p: AnyProps) => {
    props.left = p;
    const drafts = (p.drafts as PostSummary[]) ?? [];
    return (
      <div data-testid="left">
        <span data-testid="left-drafts">{drafts.map((d) => d.frontMatter.id).join(",")}</span>
        <span data-testid="left-ready">
          {((p.ready as PostSummary[]) ?? []).map((d) => d.frontMatter.id).join(",")}
        </span>
        <span data-testid="left-published">
          {((p.published as PostSummary[]) ?? []).map((d) => d.frontMatter.id).join(",")}
        </span>
        <span data-testid="left-published-total">{String(p.publishedTotal)}</span>
        <span data-testid="left-expired-total">{String(p.expiredTotal)}</span>
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
        <button data-testid="left-more-pub" onClick={() => (p.onLoadMorePublished as () => void)()}>
          more-pub
        </button>
        <button data-testid="left-more-exp" onClick={() => (p.onLoadMoreExpired as () => void)()}>
          more-exp
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
        <button data-testid="left-log" onClick={() => void (p.onRevealCurrentLogFile as () => void)()}>
          log
        </button>
        <button data-testid="left-switch" onClick={() => (p.onSwitchWorkspace as () => void)()}>
          switch
        </button>
      </div>
    );
  },
}));

vi.mock("@renderer/components/CenterPane", () => {
  const { forwardRef, useImperativeHandle } = require("react") as typeof import("react");
  return {
    CenterPane: forwardRef(function MockCenter(p: AnyProps, ref: React.Ref<unknown>) {
      props.center = p;
      useImperativeHandle(ref, () => ({ flushPendingChanges: centerFlush }), []);
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
            onClick={() => (p.onPostUpdated as (r: PostMutationResult) => void)(MUTATION_A_READY)}
          >
            updated
          </button>
          <button data-testid="center-deleted" onClick={() => (p.onPostDeleted as () => void)()}>
            deleted
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
    }),
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
          <button
            data-testid="right-updated"
            onClick={() => (p.onPostUpdated as (r: PostMutationResult) => void)(MUTATION_A_PUB)}
          >
            r-updated
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
  return (p: AnyProps) => (
    <div data-testid={testid}>
      <button data-testid={`${testid}-close`} onClick={() => (p.onClose as () => void)()}>
        close
      </button>
      {p.onCreate ? (
        <button
          data-testid={`${testid}-create`}
          onClick={() =>
            void (p.onCreate as (t: string, l: string, s?: string) => void)("blog", "en")
          }
        >
          create
        </button>
      ) : null}
      {p.onSettingsChanged ? (
        <button
          data-testid={`${testid}-changed`}
          onClick={() => (p.onSettingsChanged as () => void)()}
        >
          changed
        </button>
      ) : null}
    </div>
  );
}

vi.mock("@renderer/components/ExportModal", () => ({ ExportModal: modalMock("export-modal") }));
vi.mock("@renderer/components/NewPostModal", () => ({ NewPostModal: modalMock("newpost-modal") }));
vi.mock("@renderer/components/SettingsModal", () => ({ SettingsModal: modalMock("settings-modal") }));
vi.mock("@renderer/components/ShortcutsModal", () => ({
  ShortcutsModal: modalMock("shortcuts-modal"),
}));
vi.mock("@renderer/components/AboutModal", () => ({ AboutModal: modalMock("about-modal") }));

import { WorkspaceSession, type WorkspaceSessionHandle } from "@renderer/WorkspaceSession";
import { listPosts, createPost, listTargets, getSettings, revealCurrentLogFile } from "@renderer/api";

const mockListPosts = vi.mocked(listPosts);
const mockCreatePost = vi.mocked(createPost);
const mockListTargets = vi.mocked(listTargets);
const mockGetSettings = vi.mocked(getSettings);
const mockRevealLog = vi.mocked(revealCurrentLogFile);

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
  drafts: [summary("a", "draft"), summary("b", "draft")],
  ready: [summary("c", "ready")],
  published: [summary("p1", "published", { publishedAtUtc: "2026-02-01T00:00:00.000Z" })],
  publishedTotal: 3,
  publishedOffset: 1,
  expired: [summary("e1", "expired", { expiredAtUtc: "2026-03-01T00:00:00.000Z" })],
  expiredTotal: 2,
  expiredOffset: 1,
};

const SETTINGS: Settings = {
  timezone: "America/New_York",
  supportedLanguages: ["en", "ja"],
  publishedPostsPerLoad: 25,
  maxUploadMb: 100,
  editorWatermark: "WATER",
  extraFieldWatermark: "EXTRA",
};

const TARGETS: Target[] = [{ name: "blog", defaultLanguage: "en", requiresMetadata: true }];

const POST_A: Post = {
  frontMatter: fm("a", "draft"),
  content: "post a body",
};

const MUTATION_A_READY: PostMutationResult = {
  frontMatter: fm("a", "ready"),
  content: "post a body",
  summary: fm("a", "ready"),
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
      onStartLeftDrag={noopDrag}
      onStartRightDrag={noopDrag}
      onSwitchWorkspace={onSwitchWorkspace}
    />
  );
}

const onSwitchWorkspace = vi.fn();

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
  mockCreatePost.mockReset().mockResolvedValue(POST_B_CREATED);
  mockListTargets.mockReset().mockResolvedValue(TARGETS);
  mockGetSettings.mockReset().mockResolvedValue(SETTINGS);
  mockRevealLog.mockReset().mockResolvedValue("/path/to/log");
  centerFlush.mockReset().mockResolvedValue(true);
  rightFlush.mockReset().mockResolvedValue(true);
  insertAtCursor.mockReset();
  onSwitchWorkspace.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceSession initial load", () => {
  it("loads posts and config and feeds the left pane", async () => {
    const { getByTestId } = await mountLoaded();

    // The load effect re-runs once after settings lands a new publishedPostsPerLoad
    // (loadPosts closes over pubBatchSize), so posts may load more than once; what
    // matters is that each loader ran and the panes received the data.
    expect(mockListPosts).toHaveBeenCalled();
    expect(mockListTargets).toHaveBeenCalled();
    expect(mockGetSettings).toHaveBeenCalled();

    expect(getByTestId("left-drafts").textContent).toBe("a,b");
    expect(getByTestId("left-ready").textContent).toBe("c");
    expect(getByTestId("left-published").textContent).toBe("p1");
    expect(getByTestId("left-published-total").textContent).toBe("3");
    expect(getByTestId("left-expired-total").textContent).toBe("2");
    expect(getByTestId("left-ws-name").textContent).toBe("Alpha");
    // The settings timezone is valid, so it overrides the default.
    expect(getByTestId("left-timezone").textContent).toBe("America/New_York");
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
    expect(getByText("disk gone")).toBeTruthy();

    fireEvent.click(container.querySelector(".toolbar-error-dismiss")!);
    expect(queryByText("disk gone")).toBeNull();
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
    centerFlush.mockClear();
    rightFlush.mockClear();
    // Switching away from an open post flushes both of its panes first.
    await act(async () => {
      fireEvent.click(getByTestId("left-select-b"));
      await Promise.resolve();
    });
    expect(centerFlush).toHaveBeenCalled();
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
    centerFlush.mockClear();
    rightFlush.mockClear();
    // Re-selecting the same id short-circuits before flushing.
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    expect(centerFlush).not.toHaveBeenCalled();
  });

  it("keeps the current post when the flush refuses on a switch", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    centerFlush.mockResolvedValue(false); // dirty + save failed → block the switch
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
      fireEvent.click(getByTestId("center-updated")); // a: draft -> ready
    });
    // "a" moved out of drafts into ready. "a" and "c" share a createdAtUtc, so the
    // tie is stable and "a" appends after the existing "c".
    expect(getByTestId("left-drafts").textContent).toBe("b");
    expect(getByTestId("left-ready").textContent).toBe("c,a");
  });

  it("applies a status change from the right pane (publish)", async () => {
    const { getByTestId } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    act(() => {
      fireEvent.click(getByTestId("right-updated")); // a: draft -> published
    });
    expect(getByTestId("left-drafts").textContent).toBe("b");
    expect(getByTestId("left-published").textContent).toBe("a,p1");
    // publishedTotal incremented for the newly published post.
    expect(getByTestId("left-published-total").textContent).toBe("4");
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

    expect(mockCreatePost).toHaveBeenCalledWith("blog", "en", undefined);
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

    mockListTargets.mockClear();
    mockGetSettings.mockClear();
    await act(async () => {
      fireEvent.click(getByTestId("settings-modal-changed"));
      await Promise.resolve();
    });
    // onSettingsChanged reloads targets + settings.
    expect(mockListTargets).toHaveBeenCalledTimes(1);
    expect(mockGetSettings).toHaveBeenCalledTimes(1);
    // The analysis prompts version bumps so the right pane reloads prompts. (It
    // is only mounted with a post open, so we just assert the modal cycle here.)
    fireEvent.click(getByTestId("settings-modal-close"));
    expect(queryByTestId("settings-modal")).toBeNull();
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
  it("loads the next published page, appending it", async () => {
    const { getByTestId } = await mountLoaded();
    mockListPosts.mockClear();
    const page2: PostListResponse = {
      ...LIST,
      published: [summary("p2", "published", { publishedAtUtc: "2026-01-15T00:00:00.000Z" })],
    };
    mockListPosts.mockResolvedValue(page2);
    await act(async () => {
      fireEvent.click(getByTestId("left-more-pub"));
      await Promise.resolve();
    });
    // Appended: original page plus the next.
    expect(getByTestId("left-published").textContent).toBe("p1,p2");
    expect(mockListPosts).toHaveBeenCalledWith(1, 25, 0);
  });

  it("surfaces a load-more failure", async () => {
    const { getByTestId, getByText } = await mountLoaded();
    mockListPosts.mockRejectedValue(new Error("more failed"));
    await act(async () => {
      fireEvent.click(getByTestId("left-more-exp"));
      await Promise.resolve();
    });
    expect(getByText("more failed")).toBeTruthy();
  });

  it("reveals the current log file and surfaces a failure", async () => {
    const { getByTestId, getByText } = await mountLoaded();
    await act(async () => {
      fireEvent.click(getByTestId("left-log"));
      await Promise.resolve();
    });
    expect(mockRevealLog).toHaveBeenCalledTimes(1);

    mockRevealLog.mockRejectedValue(new Error("no log"));
    await act(async () => {
      fireEvent.click(getByTestId("left-log"));
      await Promise.resolve();
    });
    expect(getByText("no log")).toBeTruthy();
  });
});

describe("WorkspaceSession keyboard shortcuts", () => {
  function chord(key: string, target: Element | Document = document.body) {
    fireEvent.keyDown(target, { key, metaKey: true });
  }

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

  it("ignores Cmd+N originating from a TEXTAREA", async () => {
    const { getByTestId, queryByTestId } = await mountLoaded();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    act(() => chord("n", textarea));
    // TEXTAREA targets bail before the new-post branch.
    expect(queryByTestId("newpost-modal")).toBeNull();
    textarea.remove();
    void getByTestId; // keep the destructure shape consistent with siblings
  });

  it("still opens new-post from an INPUT (the one allowed input chord)", async () => {
    const { getByTestId } = await mountLoaded();
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => chord("n", input));
    expect(getByTestId("newpost-modal")).toBeTruthy();
    input.remove();
  });
});

describe("WorkspaceSession imperative flush handle", () => {
  it("exposes flushPendingChanges that fans out to both panes", async () => {
    const ref = { current: null } as React.RefObject<WorkspaceSessionHandle | null>;
    const { getByTestId } = await mountLoaded(ref as React.Ref<WorkspaceSessionHandle>);
    await act(async () => {
      fireEvent.click(getByTestId("left-select-a"));
      await Promise.resolve();
    });
    centerFlush.mockClear();
    rightFlush.mockClear();

    let result: boolean | undefined;
    await act(async () => {
      result = await ref.current!.flushPendingChanges();
    });
    expect(result).toBe(true);
    expect(centerFlush).toHaveBeenCalled();
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
