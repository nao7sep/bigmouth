import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type { PostListResponse, PostSummary } from "@shared/types";

// SourcePickerModal (the requested "PickerModal") drives usePostPicker, whose
// only backend touch is listPosts; mock the seam so the modal loads against an
// in-memory page.
vi.mock("@renderer/api", () => ({
  listPosts: vi.fn(),
}));

// jsdom has no layout: the listbox scrolls the active row into view, so stub
// scrollIntoView so arrowing never throws.
beforeEach(() => {
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  }
});

import { SourcePickerModal } from "@renderer/components/SourcePickerModal";
import { listPosts } from "@renderer/api";

const mockListPosts = vi.mocked(listPosts);

function summary(id: string, title: string): PostSummary {
  return {
    frontMatter: {
      id,
      target: "blog",
      status: "published",
      language: "en",
      createdAtUtc: "2024-01-01T00:00:00.000Z",
      title,
    },
  };
}

function page(posts: PostSummary[]): PostListResponse {
  return {
    drafts: [],
    ready: [],
    published: posts,
    publishedTotal: posts.length,
    publishedOffset: 0,
    expired: [],
    expiredTotal: 0,
    expiredOffset: 0,
  };
}

afterEach(() => {
  cleanup();
  mockListPosts.mockReset();
});

async function renderModal(
  props: Partial<{ currentPostId: string; onSelect: (id: string) => void; onClose: () => void }> = {},
) {
  const onSelect = props.onSelect ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const utils = render(
    <SourcePickerModal
      currentPostId={props.currentPostId ?? "current"}
      pubBatchSize={50}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  // Flush the usePostPicker load so the rows render.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { onSelect, onClose, ...utils };
}

describe("SourcePickerModal — render", () => {
  it("renders the dialog and the loaded posts, autofocusing the filter", async () => {
    mockListPosts.mockResolvedValue(page([summary("p1", "Alpha"), summary("p2", "Beta")]));
    const { getByRole, getByText, getByPlaceholderText } = await renderModal();

    const labelId = getByRole("dialog").getAttribute("aria-labelledby");
    expect(document.getElementById(labelId!)?.textContent).toBe("Link Source Post");
    expect(getByText("Alpha")).toBeTruthy();
    expect(getByText("Beta")).toBeTruthy();
    // PostPickerList is rendered with autoFocus, so the filter holds focus.
    expect(document.activeElement).toBe(getByPlaceholderText("Filter posts…"));
  });

  it("excludes the current post from the candidate list", async () => {
    mockListPosts.mockResolvedValue(page([summary("current", "Self"), summary("p2", "Other")]));
    const { getByText, queryByText } = await renderModal({ currentPostId: "current" });
    // The post being edited cannot be its own source.
    expect(queryByText("Self")).toBeNull();
    expect(getByText("Other")).toBeTruthy();
  });

  it("surfaces a load failure in the list", async () => {
    mockListPosts.mockRejectedValue(new Error("index unreadable"));
    const { getByText } = await renderModal();
    expect(getByText("index unreadable")).toBeTruthy();
  });
});

describe("SourcePickerModal — selection and close", () => {
  it("selects a post and closes the modal on click", async () => {
    mockListPosts.mockResolvedValue(page([summary("p1", "Alpha"), summary("p2", "Beta")]));
    const { onSelect, onClose, getByText } = await renderModal();

    fireEvent.click(getByText("Beta"));
    expect(onSelect).toHaveBeenCalledWith("p2");
    // Picking is one-shot: the modal dismisses immediately after.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("commits the cursor row on Enter and closes", async () => {
    mockListPosts.mockResolvedValue(page([summary("p1", "Alpha"), summary("p2", "Beta")]));
    const { onSelect, onClose, getByLabelText } = await renderModal();

    const listbox = getByLabelText("Posts");
    fireEvent.keyDown(listbox, { key: "Enter" }); // autoActivateFirst rests on row 0
    expect(onSelect).toHaveBeenCalledWith("p1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without selecting (the modal has no dirty guard)", async () => {
    mockListPosts.mockResolvedValue(page([summary("p1", "Alpha")]));
    const { onSelect, onClose } = await renderModal();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes via the backdrop", async () => {
    mockListPosts.mockResolvedValue(page([summary("p1", "Alpha")]));
    const { onClose, container } = await renderModal();
    fireEvent.click(container.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
