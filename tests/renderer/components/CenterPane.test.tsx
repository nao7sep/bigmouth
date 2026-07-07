import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { createRef } from "react";
import type { Post, PostMutationResult, PostFrontMatter } from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";

// CenterPane's only backend seam is these api calls; mock the lot.
vi.mock("@renderer/api", () => ({
  getPost: vi.fn(),
  updatePost: vi.fn(),
  changePostStatus: vi.fn(),
  deletePost: vi.fn(),
  listReferrers: vi.fn(),
}));

// The CodeMirror editor and the source-picker modal are heavy children; replace
// them with stand-ins so the test focuses on CenterPane's toolbar/status/save
// logic. The editor stand-in exposes a textarea that drives onContentChange.
vi.mock("@renderer/components/MarkdownEditor", () => ({
  MarkdownEditor: (props: {
    content: string;
    onContentChange: (v: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      data-testid="editor"
      data-readonly={String(props.readOnly)}
      value={props.content}
      onChange={(e) => props.onContentChange(e.target.value)}
    />
  ),
}));
vi.mock("@renderer/components/SourcePickerModal", () => ({
  SourcePickerModal: (props: { onSelect: (id: string) => void; onClose: () => void }) => (
    <div data-testid="source-picker">
      <button onClick={() => props.onSelect("src-1")}>pick-source</button>
      <button onClick={props.onClose}>close-picker</button>
    </div>
  ),
}));

import { CenterPane, type CenterPaneHandle } from "@renderer/components/CenterPane";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import {
  getPost,
  updatePost,
  changePostStatus,
  deletePost,
  listReferrers,
} from "@renderer/api";

const mockGetPost = vi.mocked(getPost);
const mockUpdatePost = vi.mocked(updatePost);
const mockChangeStatus = vi.mocked(changePostStatus);
const mockDeletePost = vi.mocked(deletePost);
const mockListReferrers = vi.mocked(listReferrers);

function fm(over: Partial<PostFrontMatter> = {}): PostFrontMatter {
  return {
    id: "p1",
    target: "blog",
    status: "draft",
    language: "en",
    createdAtUtc: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

function post(over: Partial<PostFrontMatter> = {}, content = "initial body"): Post {
  return { frontMatter: fm(over), content };
}

function mutationResult(p: Post): PostMutationResult {
  return { ...p, summary: p.frontMatter };
}

function baseProps() {
  return {
    workspaceId: "w1",
    postId: "p1",
    onPostUpdated: vi.fn(),
    onPostDeleted: vi.fn(),
    onContentChange: vi.fn(),
    onPostLoaded: vi.fn(),
    onExport: vi.fn(),
    onSelectPost: vi.fn(),
    pubBatchSize: 10,
    watermark: "Write…",
    contentFont: DEFAULT_CONTENT_FONT,
    // Optional props, declared here so the override type accepts them.
    onGoBack: undefined as (() => void) | undefined,
    onBeforeStatusChange: undefined as (() => Promise<boolean>) | undefined,
  };
}

async function renderPane(
  over: Partial<ReturnType<typeof baseProps>> = {},
  ref?: React.Ref<CenterPaneHandle>
) {
  const props = { ...baseProps(), ...over };
  const utils = render(
    <ConfirmProvider>
      <CenterPane ref={ref} {...props} />
    </ConfirmProvider>
  );
  // Loading resolves asynchronously; wait for the toolbar to appear.
  await waitFor(() => expect(utils.container.querySelector(".center-toolbar")).toBeTruthy());
  return { ...utils, props };
}

beforeEach(() => {
  mockGetPost.mockReset();
  mockUpdatePost.mockReset();
  mockChangeStatus.mockReset();
  mockDeletePost.mockReset();
  mockListReferrers.mockReset();
  mockGetPost.mockResolvedValue(post());
});

afterEach(cleanup);

describe("CenterPane loading", () => {
  it("shows the loading placeholder before the post arrives, then renders the toolbar", async () => {
    // A getPost that never resolves leaves the pane in its loading state.
    mockGetPost.mockImplementation(() => new Promise(() => {}));
    const { container } = render(
      <ConfirmProvider>
        <CenterPane {...baseProps()} />
      </ConfirmProvider>
    );
    expect(container.querySelector(".center-loading")?.textContent).toBe("Loading post…");
    expect(container.querySelector(".center-editor")).toBeNull();
  });

  it("shows the load error when getPost rejects", async () => {
    mockGetPost.mockRejectedValue(new Error("disk gone"));
    const { container } = render(
      <ConfirmProvider>
        <CenterPane {...baseProps()} />
      </ConfirmProvider>
    );
    await waitFor(() => expect(container.querySelector(".center-loading")?.textContent).toBe("disk gone"));
    expect(container.querySelector(".toolbar-label")?.textContent).toBe("Load failed");
  });

  it("loads the post, seeds the editor, and notifies the parent", async () => {
    const onContentChange = vi.fn();
    const onPostLoaded = vi.fn();
    await renderPane({ onContentChange, onPostLoaded });
    expect((screen.getByTestId("editor") as HTMLTextAreaElement).value).toBe("initial body");
    expect(onContentChange).toHaveBeenCalledWith("initial body");
    expect(onPostLoaded).toHaveBeenCalledTimes(1);
  });
});

describe("CenterPane toolbar metadata", () => {
  it("renders target, language, and the four status radios", async () => {
    await renderPane();
    const labels = screen.getAllByText((_, el) => el?.className === "toolbar-label").map((e) => e.textContent);
    expect(labels).toContain("blog");
    expect(labels).toContain("en");
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([
      "Draft",
      "Ready",
      "Published",
      "Expired",
    ]);
  });

  it("marks the current status radio as checked/active", async () => {
    mockGetPost.mockResolvedValue(post({ status: "ready" }));
    await renderPane();
    const ready = screen.getByRole("radio", { name: "Ready" });
    expect(ready.getAttribute("aria-checked")).toBe("true");
    expect(ready.className).toContain("active");
  });
});

describe("CenterPane content autosave", () => {
  it("debounces an edit and saves the new content after the delay", async () => {
    vi.useFakeTimers();
    try {
      mockGetPost.mockResolvedValue(post());
      const onPostUpdated = vi.fn();
      render(
        <ConfirmProvider>
          <CenterPane {...baseProps()} onPostUpdated={onPostUpdated} />
        </ConfirmProvider>
      );
      // Flush the load promise.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
      mockUpdatePost.mockResolvedValue(mutationResult(post({}, "edited body")));
      fireEvent.change(editor, { target: { value: "edited body" } });
      // Not yet saved before the 2s debounce.
      expect(mockUpdatePost).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockUpdatePost).toHaveBeenCalledWith("p1", { content: "edited body" }, "w1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushPendingChanges persists a pending edit immediately and reports success", async () => {
    const ref = createRef<CenterPaneHandle>();
    await renderPane({}, ref);
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    mockUpdatePost.mockResolvedValue(mutationResult(post({}, "flushed body")));
    fireEvent.change(editor, { target: { value: "flushed body" } });
    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await ref.current!.flushPendingChanges();
    });
    expect(flushed).toBe(true);
    expect(mockUpdatePost).toHaveBeenCalledWith("p1", { content: "flushed body" }, "w1");
  });

  it("flushPendingChanges resolves true with nothing to save", async () => {
    const ref = createRef<CenterPaneHandle>();
    await renderPane({}, ref);
    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await ref.current!.flushPendingChanges();
    });
    expect(flushed).toBe(true);
    expect(mockUpdatePost).not.toHaveBeenCalled();
  });

  it("surfaces a save error and reports flush failure when updatePost rejects", async () => {
    const ref = createRef<CenterPaneHandle>();
    const { container } = await renderPane({}, ref);
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    mockUpdatePost.mockRejectedValue(new Error("save broke"));
    fireEvent.change(editor, { target: { value: "doomed body" } });
    let flushed: boolean | undefined;
    await act(async () => {
      flushed = await ref.current!.flushPendingChanges();
    });
    expect(flushed).toBe(false);
    // The save loop records the underlying error, but flush then sees the content
    // still unsaved and overwrites the toolbar with its own "resolve before
    // leaving" message — that is the final visible error.
    await waitFor(() =>
      expect(container.querySelector(".toolbar-error")?.textContent).toContain(
        "Autosave failed. Resolve it before leaving this post."
      )
    );
  });
});

describe("CenterPane status changes", () => {
  it("commits a non-destructive status change and notifies the parent", async () => {
    const onPostUpdated = vi.fn();
    mockGetPost.mockResolvedValue(post({ status: "draft" }));
    mockChangeStatus.mockResolvedValue(mutationResult(post({ status: "ready" })));
    await renderPane({ onPostUpdated });
    fireEvent.click(screen.getByRole("radio", { name: "Ready" }));
    await waitFor(() => expect(mockChangeStatus).toHaveBeenCalledWith("p1", "ready", "w1"));
    await waitFor(() => expect(onPostUpdated).toHaveBeenCalled());
  });

  it("ignores a click on the already-current status", async () => {
    mockGetPost.mockResolvedValue(post({ status: "draft" }));
    await renderPane();
    fireEvent.click(screen.getByRole("radio", { name: "Draft" }));
    expect(mockChangeStatus).not.toHaveBeenCalled();
  });

  it("prompts before reverting a published post to draft, then applies on confirm", async () => {
    const onPostUpdated = vi.fn();
    mockGetPost.mockResolvedValue(post({ status: "published", publishedAtUtc: "2024-02-02T00:00:00.000Z" }));
    mockChangeStatus.mockResolvedValue(mutationResult(post({ status: "draft" })));
    await renderPane({ onPostUpdated });
    fireEvent.click(screen.getByRole("radio", { name: "Draft" }));
    // A confirm dialog appears before any status change.
    await screen.findByText("Revert to draft?");
    expect(mockChangeStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revert to Draft" }));
    await waitFor(() => expect(mockChangeStatus).toHaveBeenCalledWith("p1", "draft", "w1"));
  });

  it("does not change status if the revert-to-draft prompt is cancelled", async () => {
    mockGetPost.mockResolvedValue(post({ status: "published", publishedAtUtc: "2024-02-02T00:00:00.000Z" }));
    await renderPane();
    fireEvent.click(screen.getByRole("radio", { name: "Draft" }));
    await screen.findByText("Revert to draft?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Revert to draft?")).toBeNull());
    expect(mockChangeStatus).not.toHaveBeenCalled();
  });

  it("shows a status error when changePostStatus rejects", async () => {
    mockGetPost.mockResolvedValue(post({ status: "draft" }));
    mockChangeStatus.mockRejectedValue(new Error("status nope"));
    const { container } = await renderPane();
    fireEvent.click(screen.getByRole("radio", { name: "Ready" }));
    await waitFor(() => expect(container.querySelector(".toolbar-error")?.textContent).toContain("status nope"));
  });
});

describe("CenterPane locked posts", () => {
  it("shows the published lock notice and makes the editor read-only", async () => {
    mockGetPost.mockResolvedValue(post({ status: "published" }));
    const { container } = await renderPane();
    expect(container.querySelector(".toolbar-notice")?.textContent).toContain("Published posts are locked");
    expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("true");
  });

  it("shows the expired lock notice for an expired post", async () => {
    mockGetPost.mockResolvedValue(post({ status: "expired" }));
    const { container } = await renderPane();
    expect(container.querySelector(".toolbar-notice")?.textContent).toContain("Expired posts are locked");
  });

  it("does not autosave edits attempted on a locked post", async () => {
    vi.useFakeTimers();
    try {
      mockGetPost.mockResolvedValue(post({ status: "published" }));
      render(
        <ConfirmProvider>
          <CenterPane {...baseProps()} />
        </ConfirmProvider>
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
      fireEvent.change(editor, { target: { value: "sneaky edit" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockUpdatePost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CenterPane source linking", () => {
  it("opens the source picker and links the chosen source", async () => {
    mockGetPost.mockResolvedValue(post({ status: "draft" }));
    mockUpdatePost.mockResolvedValue(mutationResult(post({ sourceId: "src-1" })));
    const onPostUpdated = vi.fn();
    await renderPane({ onPostUpdated });
    fireEvent.click(screen.getByRole("button", { name: "Link Source" }));
    expect(screen.getByTestId("source-picker")).toBeTruthy();
    fireEvent.click(screen.getByText("pick-source"));
    await waitFor(() =>
      expect(mockUpdatePost).toHaveBeenCalledWith("p1", { frontMatter: { sourceId: "src-1" } }, "w1")
    );
  });

  it("unlinks the source and navigates to it via the Source affordance", async () => {
    mockGetPost.mockResolvedValue(post({ status: "draft", sourceId: "src-9" }));
    mockUpdatePost.mockResolvedValue(mutationResult(post({ status: "draft" })));
    const onSelectPost = vi.fn();
    const { container } = await renderPane({ onSelectPost });
    // The Source label navigates to the linked post.
    fireEvent.click(container.querySelector(".toolbar-source")!);
    expect(onSelectPost).toHaveBeenCalledWith("src-9");
    // Unlink clears the source.
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() =>
      expect(mockUpdatePost).toHaveBeenCalledWith("p1", { frontMatter: { sourceId: null } }, "w1")
    );
  });
});

describe("CenterPane toolbar actions", () => {
  it("fires onExport when Export is clicked", async () => {
    const onExport = vi.fn();
    await renderPane({ onExport });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("renders a Back button only when onGoBack is provided and fires it", async () => {
    const onGoBack = vi.fn();
    const { container, rerender } = await renderPane({ onGoBack });
    fireEvent.click(screen.getByRole("button", { name: "◀ Back" }));
    expect(onGoBack).toHaveBeenCalledTimes(1);
    // Without onGoBack, no Back button.
    rerender(
      <ConfirmProvider>
        <CenterPane {...baseProps()} />
      </ConfirmProvider>
    );
    expect(container.querySelector(".btn-toolbar")?.textContent).not.toBe("◀ Back");
  });
});

describe("CenterPane delete", () => {
  it("confirms (mentioning referrers) then deletes and notifies the parent", async () => {
    mockListReferrers.mockResolvedValue({ count: 2, ids: ["a", "b"] });
    mockDeletePost.mockResolvedValue(undefined);
    const onPostDeleted = vi.fn();
    const { container } = await renderPane({ onPostDeleted });
    // The toolbar Delete button opens the confirm.
    fireEvent.click(container.querySelector(".btn-delete")!);
    // The referrer count appears in the confirm message.
    await screen.findByText((t) => t.includes("2 other posts link"));
    // The confirm dialog's Delete button lives in the modal footer.
    const confirmBtn = document
      .querySelector(".modal-footer")!
      .querySelector("button.btn-delete") as HTMLButtonElement;
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(mockDeletePost).toHaveBeenCalledWith("p1", "w1"));
    await waitFor(() => expect(onPostDeleted).toHaveBeenCalledTimes(1));
  });

  it("does not delete when the confirm is cancelled", async () => {
    mockListReferrers.mockResolvedValue({ count: 0, ids: [] });
    await renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText("Delete this post? This cannot be undone.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Delete this post? This cannot be undone.")).toBeNull());
    expect(mockDeletePost).not.toHaveBeenCalled();
  });
});
