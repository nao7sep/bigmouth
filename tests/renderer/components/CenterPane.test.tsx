import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import type { Post, PostIndexEntry, PostMutationResult, PostFrontMatter } from "@shared/types";
import { DEFAULT_CONTENT_FONT } from "@shared/types";

// CenterPane's only backend seam is these api calls; mock the lot. Content
// saves stream through queuePostContent (fire-and-forget) and come back as
// events; the captured listeners let tests play the main process's part.
const savedListeners = vi.hoisted(
  () => new Set<(e: { postId: string; summary: PostIndexEntry; newerEditHeld: boolean }) => void>()
);
const failedListeners = vi.hoisted(
  () => new Set<(e: { postId: string; kind: "retrying" | "unsaveable" }) => void>()
);
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  getPost: vi.fn(),
  updatePost: vi.fn(),
  changePostStatus: vi.fn(),
  setPostLocked: vi.fn(),
  deletePost: vi.fn(),
  listReferrers: vi.fn(),
  queuePostContent: vi.fn(),
  onPostContentSaved: (cb: (e: { postId: string; summary: PostIndexEntry; newerEditHeld: boolean }) => void) => {
    savedListeners.add(cb);
    return () => savedListeners.delete(cb);
  },
  onPostContentSaveFailed: (
    cb: (e: { postId: string; kind: "retrying" | "unsaveable" }) => void
  ) => {
    failedListeners.add(cb);
    return () => failedListeners.delete(cb);
  },
}));

// The CodeMirror editor and the source-picker modal are heavy children; replace
// them with stand-ins so the test focuses on CenterPane's toolbar/status/save
// logic. The editor stand-in exposes a textarea that drives onContentChange.
vi.mock("@renderer/components/MarkdownEditor", () => ({
  MarkdownEditor: (props: {
    initialContent: string;
    onContentChange: (v: string) => void;
    readOnly?: boolean;
  }) => (
    <textarea
      data-testid="editor"
      data-readonly={String(props.readOnly)}
      value={props.initialContent}
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

import { CenterPane } from "@renderer/components/CenterPane";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import {
  getPost,
  updatePost,
  changePostStatus,
  setPostLocked,
  deletePost,
  listReferrers,
  queuePostContent,
} from "@renderer/api";

const mockGetPost = vi.mocked(getPost);
const mockUpdatePost = vi.mocked(updatePost);
const mockChangeStatus = vi.mocked(changePostStatus);
const mockSetLocked = vi.mocked(setPostLocked);
const mockDeletePost = vi.mocked(deletePost);
const mockListReferrers = vi.mocked(listReferrers);
const mockQueueContent = vi.mocked(queuePostContent);
let clipboardWrite: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

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

/**
 * What main actually sends on a background save: the index projection. It has a
 * fileName and deliberately no updatedAtUtc, so the test plays the real payload
 * rather than a full front matter the channel never carries.
 */
function indexEntry(over: Partial<PostIndexEntry> = {}): PostIndexEntry {
  return {
    id: "p1",
    fileName: "20240101-000000-utc-p1.md",
    status: "draft",
    target: "blog",
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
    rereadPost: undefined as Post | null | undefined,
  };
}

async function renderPane(over: Partial<ReturnType<typeof baseProps>> = {}) {
  const props = { ...baseProps(), ...over };
  const utils = render(
    <ConfirmProvider>
      <CenterPane {...props} />
    </ConfirmProvider>
  );
  // Wait for the LOADED state, not merely for the toolbar element. `.center-toolbar`
  // also renders while loading (it holds the "Loading…" label), so gating on it let this
  // helper return with the placeholder still on screen — after which every synchronous
  // getByRole below queries a DOM that has no controls in it yet. That is a race in every
  // test using this helper, not just the one that happened to lose it (~1 run in 30).
  // `.center-loading` is present in exactly the not-yet-loaded states and gone once the
  // post renders, so its absence is the real signal. The error path never uses this
  // helper — it renders inline and asserts on `.center-loading` itself.
  await waitFor(() => expect(utils.container.querySelector(".center-loading")).toBeNull());
  return { ...utils, props };
}

beforeEach(() => {
  mockGetPost.mockReset();
  mockUpdatePost.mockReset();
  mockChangeStatus.mockReset();
  mockSetLocked.mockReset();
  mockDeletePost.mockReset();
  mockListReferrers.mockReset();
  mockQueueContent.mockReset();
  savedListeners.clear();
  failedListeners.clear();
  mockGetPost.mockResolvedValue(post());
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
});

afterEach(() => {
  cleanup();
  if (originalClipboard) {
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

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
    await waitFor(() => expect(container.querySelector(".center-loading")?.textContent)
      .toBe("This post could not be loaded. Select it again to retry."));
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
  it("renders target, language, and the five status radios in status order", async () => {
    await renderPane();
    const labels = screen.getAllByText((_, el) => el?.className === "toolbar-label").map((e) => e.textContent);
    expect(labels).toContain("blog");
    expect(labels).toContain("en");
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([
      "Draft",
      "Discarded",
      "Verified",
      "Published",
      "Retired",
    ]);
  });

  it("names a renamed target from the session's reread, keeping the editor text", async () => {
    const { props, rerender, container } = await renderPane();
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "typed since load" } });

    rerender(
      <ConfirmProvider>
        <CenterPane {...props} rereadPost={post({ target: "renamed" }, "older text on disk")} />
      </ConfirmProvider>
    );
    const labels = [...container.querySelectorAll(".toolbar-label")].map((e) => e.textContent);
    expect(labels).toContain("renamed");
    expect(labels).not.toContain("blog");
    expect((screen.getByTestId("editor") as HTMLTextAreaElement).value).toBe("typed since load");
  });

  it("ignores a reread that predates the pane", async () => {
    const stale = post({ target: "stale" });
    const { container } = await renderPane({ rereadPost: stale });
    const labels = [...container.querySelectorAll(".toolbar-label")].map((e) => e.textContent);
    expect(labels).toContain("blog");
    expect(labels).not.toContain("stale");
  });

  it("marks the current status radio as checked/active", async () => {
    mockGetPost.mockResolvedValue(post({ status: "verified" }));
    await renderPane();
    const verified = screen.getByRole("radio", { name: "Verified" });
    expect(verified.getAttribute("aria-checked")).toBe("true");
    expect(verified.className).toContain("active");
  });
});

describe("CenterPane content saves (streamed to the main process)", () => {
  it("streams every edit to the main-process saver immediately", async () => {
    await renderPane();
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "edited body" } });
    expect(mockQueueContent).toHaveBeenCalledWith("p1", "edited body", "w1");
    // No renderer-side save round-trip: content never goes through updatePost.
    expect(mockUpdatePost).not.toHaveBeenCalled();
  });

  it("shows the save error when the saver reports a failure for this post", async () => {
    const { container } = await renderPane();
    act(() => {
      failedListeners.forEach((cb) => cb({ postId: "p1", kind: "retrying" }));
    });
    await waitFor(() =>
      expect(container.querySelector(".toolbar-error")?.textContent).toContain(
        "Autosave failed and will retry."
      )
    );
  });

  it("ignores save events for other posts", async () => {
    const { container } = await renderPane();
    act(() => {
      failedListeners.forEach((cb) => cb({ postId: "other", kind: "retrying" }));
    });
    expect(container.querySelector(".toolbar-error")).toBeFalsy();
  });

  it("clears the save error once a save lands", async () => {
    const { container } = await renderPane();
    act(() => {
      failedListeners.forEach((cb) => cb({ postId: "p1", kind: "retrying" }));
    });
    await waitFor(() => expect(container.querySelector(".toolbar-error")).toBeTruthy());
    act(() => {
      savedListeners.forEach((cb) => cb({ postId: "p1", summary: indexEntry(), newerEditHeld: false }));
    });
    await waitFor(() => expect(container.querySelector(".toolbar-error")).toBeFalsy());
  });

  it("keeps the retrying notice when newer text is still held behind the save", async () => {
    const { container } = await renderPane();
    act(() => {
      failedListeners.forEach((cb) => cb({ postId: "p1", kind: "retrying" }));
    });
    await waitFor(() => expect(container.querySelector(".toolbar-error")).toBeTruthy());
    act(() => {
      savedListeners.forEach((cb) => cb({ postId: "p1", summary: indexEntry(), newerEditHeld: true }));
    });
    expect(container.querySelector(".toolbar-error")?.textContent).toContain("Autosave failed and will retry.");
    act(() => {
      savedListeners.forEach((cb) => cb({ postId: "p1", summary: indexEntry(), newerEditHeld: false }));
    });
    await waitFor(() => expect(container.querySelector(".toolbar-error")).toBeFalsy());
  });

  it("says a terminal failure cannot be saved, and keeps the text on screen", async () => {
    const { container } = await renderPane();
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "work that can never be saved" } });

    act(() => {
      failedListeners.forEach((cb) =>
        cb({ postId: "p1", kind: "unsaveable" })
      );
    });

    const error = await waitFor(() => {
      const node = container.querySelector(".toolbar-error");
      expect(node).toBeTruthy();
      return node!;
    });
    // Why we cannot save, and that the text is still here — never a promise to
    // retry, which for a missing post would be a lie.
    expect(error.textContent).toContain("BigMouth cannot save your changes.");
    expect(error.textContent).toContain("copy it somewhere safe");
    expect(error.textContent).not.toContain("will retry");
    // The editor still holds the user's work, which is the only copy left.
    expect(editor.value).toBe("work that can never be saved");
  });
});

describe("CenterPane status changes", () => {
  it("commits a status change and notifies the parent", async () => {
    const onPostUpdated = vi.fn();
    mockGetPost.mockResolvedValue(post({ status: "draft" }));
    mockChangeStatus.mockResolvedValue(mutationResult(post({ status: "verified" })));
    await renderPane({ onPostUpdated });
    fireEvent.click(screen.getByRole("radio", { name: "Verified" }));
    await waitFor(() => expect(mockChangeStatus).toHaveBeenCalledWith("p1", "verified", "w1"));
    await waitFor(() => expect(onPostUpdated).toHaveBeenCalled());
  });

  it("ignores a click on the already-current status", async () => {
    mockGetPost.mockResolvedValue(post({ status: "draft" }));
    await renderPane();
    fireEvent.click(screen.getByRole("radio", { name: "Draft" }));
    expect(mockChangeStatus).not.toHaveBeenCalled();
  });

  // Only published and retired hold a publication time, so moving a post that
  // has one anywhere else loses it for good.
  it.each([
    ["published", "Draft", "draft"],
    ["published", "Discarded", "discarded"],
    ["published", "Verified", "verified"],
    ["retired", "Draft", "draft"],
    ["retired", "Verified", "verified"],
  ] as const)("prompts before a %s post moves to %s, then applies on confirm", async (from, label, to) => {
    mockGetPost.mockResolvedValue(post({ status: from, publishedAtUtc: "2024-02-02T00:00:00.000Z" }));
    mockChangeStatus.mockResolvedValue(mutationResult(post({ status: to })));
    await renderPane();
    fireEvent.click(screen.getByRole("radio", { name: label }));
    // A confirm dialog appears before any status change.
    await screen.findByText("Clear the publication time?");
    expect(
      screen.getByText(`Moving this post to ${label} clears its publication time, and it will be treated as never published. Publishing it again gives it a new publication time.`),
    ).toBeTruthy();
    expect(mockChangeStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `Move to ${label}` }));
    await waitFor(() => expect(mockChangeStatus).toHaveBeenCalledWith("p1", to, "w1"));
  });

  it.each([
    ["published", "Retired", "retired"],
    ["retired", "Published", "published"],
  ] as const)("moves a %s post to %s without a prompt: the publication time is kept", async (from, label, to) => {
    mockGetPost.mockResolvedValue(post({ status: from, publishedAtUtc: "2024-02-02T00:00:00.000Z" }));
    mockChangeStatus.mockResolvedValue(mutationResult(post({ status: to })));
    await renderPane();
    fireEvent.click(screen.getByRole("radio", { name: label }));
    await waitFor(() => expect(mockChangeStatus).toHaveBeenCalledWith("p1", to, "w1"));
    expect(screen.queryByText("Clear the publication time?")).toBeNull();
  });

  it("does not change status if the prompt is cancelled", async () => {
    mockGetPost.mockResolvedValue(post({ status: "published", publishedAtUtc: "2024-02-02T00:00:00.000Z" }));
    await renderPane();
    fireEvent.click(screen.getByRole("radio", { name: "Draft" }));
    await screen.findByText("Clear the publication time?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Clear the publication time?")).toBeNull());
    expect(mockChangeStatus).not.toHaveBeenCalled();
  });

  it("shows a status error when changePostStatus rejects", async () => {
    mockGetPost.mockResolvedValue(post({ status: "draft" }));
    mockChangeStatus.mockRejectedValue(new Error("status nope"));
    const { container } = await renderPane();
    fireEvent.click(screen.getByRole("radio", { name: "Verified" }));
    await waitFor(() => expect(container.querySelector(".toolbar-error")?.textContent)
      .toContain("The post status could not be changed. The previous status is still in effect; try again."));
  });
});

describe("CenterPane lock", () => {
  const lockButton = () => screen.getByRole("button", { name: "Locked" });

  it("is a toggle button beside the status radios, off for an unlocked post", async () => {
    await renderPane();
    expect(lockButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("locks the post, flushing the Metadata tab first, and notifies the parent", async () => {
    const onPostUpdated = vi.fn();
    const onBeforeStatusChange = vi.fn().mockResolvedValue(true);
    mockSetLocked.mockResolvedValue(mutationResult(post({ locked: true })));
    await renderPane({ onPostUpdated, onBeforeStatusChange });

    fireEvent.click(lockButton());

    await waitFor(() => expect(mockSetLocked).toHaveBeenCalledWith("p1", true, "w1"));
    expect(onBeforeStatusChange).toHaveBeenCalled();
    await waitFor(() => expect(lockButton().getAttribute("aria-pressed")).toBe("true"));
    expect(onPostUpdated).toHaveBeenCalled();
  });

  it("does not lock while a Metadata value the store refused is unresolved", async () => {
    const { container } = await renderPane({ onBeforeStatusChange: vi.fn().mockResolvedValue(false) });
    fireEvent.click(lockButton());
    await waitFor(() => expect(container.querySelector(".toolbar-error")?.textContent)
      .toContain("Metadata changes could not be saved. Fix them before locking the post."));
    expect(mockSetLocked).not.toHaveBeenCalled();
  });

  it("unlocks a locked post", async () => {
    mockGetPost.mockResolvedValue(post({ locked: true }));
    mockSetLocked.mockResolvedValue(mutationResult(post()));
    await renderPane();
    expect(lockButton().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(lockButton());
    await waitFor(() => expect(mockSetLocked).toHaveBeenCalledWith("p1", false, "w1"));
    await waitFor(() => expect(lockButton().getAttribute("aria-pressed")).toBe("false"));
  });

  it("says when the lock could not be changed", async () => {
    mockSetLocked.mockRejectedValue(new Error("disk full"));
    const { container } = await renderPane();
    fireEvent.click(lockButton());
    await waitFor(() => expect(container.querySelector(".toolbar-error")?.textContent)
      .toContain("The post could not be locked. It is still unlocked; try again."));
  });
});

describe("CenterPane locked posts", () => {
  it("shows the one locked notice and locks the editor, whatever the status", async () => {
    for (const status of ["draft", "published"] as const) {
      cleanup();
      mockGetPost.mockResolvedValue(post({ status, locked: true }));
      const { container } = await renderPane();
      expect(container.querySelector(".toolbar-notice")?.textContent).toBe(
        "This post is locked. Unlock it to edit its text, metadata, assets or source link.",
      );
      expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("true");
    }
  });

  it("leaves an unlocked published post editable", async () => {
    mockGetPost.mockResolvedValue(post({ status: "published", publishedAtUtc: "2024-02-02T00:00:00.000Z" }));
    const { container } = await renderPane();
    expect(container.querySelector(".toolbar-notice")).toBeNull();
    expect(screen.getByTestId("editor").getAttribute("data-readonly")).toBe("false");
  });

  it("keeps the status radios, the lock and delete live, and the source link locked", async () => {
    mockGetPost.mockResolvedValue(post({ locked: true, sourceId: "src-9" }));
    mockChangeStatus.mockResolvedValue(mutationResult(post({ status: "verified", locked: true })));
    await renderPane();
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLButtonElement).disabled)).toBe(true);
    expect((screen.getByRole("button", { name: "Locked" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Change" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Unlink" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: "Verified" }));
    await waitFor(() => expect(mockChangeStatus).toHaveBeenCalledWith("p1", "verified", "w1"));
  });

  it("does not stream edits attempted on a locked post", async () => {
    mockGetPost.mockResolvedValue(post({ locked: true }));
    render(
      <ConfirmProvider>
        <CenterPane {...baseProps()} />
      </ConfirmProvider>
    );
    // Not a fixed number of microtask ticks: how many the load takes is an implementation
    // detail of the hook, and guessing it is the same race renderPane above just lost.
    const editor = (await screen.findByTestId("editor")) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "sneaky edit" } });
    expect(mockQueueContent).not.toHaveBeenCalled();
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
  it("keeps a failed copy beside the editor toolbar", async () => {
    clipboardWrite.mockRejectedValueOnce(new Error("denied"));
    await renderPane();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });

    const result = screen.getByRole("alert");
    expect(result.textContent).toContain("Could not copy to the clipboard");
    expect(result.closest(".pane-center")).toBeTruthy();
  });

  it("fires onExport when Export is clicked", async () => {
    const onExport = vi.fn();
    await renderPane({ onExport });
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("renders a Back button only when onGoBack is provided and fires it", async () => {
    const onGoBack = vi.fn();
    const { container, rerender } = await renderPane({ onGoBack });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onGoBack).toHaveBeenCalledTimes(1);
    // Without onGoBack, no Back button.
    rerender(
      <ConfirmProvider>
        <CenterPane {...baseProps()} />
      </ConfirmProvider>
    );
    expect(container.querySelector(".btn-toolbar")?.textContent?.trim()).not.toBe("Back");
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
      .querySelector("button.btn-delete-confirm") as HTMLButtonElement;
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(mockDeletePost).toHaveBeenCalledWith("p1", "w1"));
    await waitFor(() => expect(onPostDeleted).toHaveBeenCalledTimes(1));
  });

  it("queues no second confirm when Delete is clicked twice", async () => {
    // Nothing disabled the button and nothing guarded re-entry, so two fast
    // clicks enqueued two confirms: the first deleted the post and moved the
    // selection, then the second asked to delete a post that was already gone.
    mockListReferrers.mockResolvedValue({ count: 0, ids: [] });
    mockDeletePost.mockResolvedValue(undefined);
    const { container } = await renderPane();

    const button = container.querySelector(".btn-delete")!;
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText("Delete this post? This cannot be undone.");

    const confirmBtn = document
      .querySelector(".modal-footer")!
      .querySelector("button.btn-delete-confirm") as HTMLButtonElement;
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(mockDeletePost).toHaveBeenCalledTimes(1));
    // And no second dialog is waiting behind the first.
    await waitFor(() =>
      expect(screen.queryByText("Delete this post? This cannot be undone.")).toBeNull(),
    );
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
