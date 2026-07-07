import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import type { PostSummary } from "@shared/types";
import type { PostPickerState } from "@renderer/hooks/usePostPicker";

// PostPickerList (the requested "PickerList") is a controlled view over a
// usePostPicker state object — it makes no api calls of its own, so the picker
// state is supplied directly via props rather than mocked through the seam.
import { PostPickerList } from "@renderer/components/PostPickerList";

// jsdom has no layout: the listbox scrolls the active row into view, so stub
// scrollIntoView so arrowing never throws.
beforeEach(() => {
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  }
});

afterEach(cleanup);

function summary(over: Partial<PostSummary["frontMatter"]> = {}): PostSummary {
  return {
    frontMatter: {
      id: over.id ?? "p1",
      target: over.target ?? "blog",
      status: over.status ?? "published",
      language: over.language ?? "en",
      createdAtUtc: "2024-01-01T00:00:00.000Z",
      title: over.title,
      ...over,
    },
  };
}

function state(over: Partial<PostPickerState> = {}): PostPickerState {
  return {
    posts: [],
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
    query: "",
    setQuery: vi.fn(),
    error: null,
    ...over,
  };
}

describe("PostPickerList — render", () => {
  it("renders a filter input and a labelled listbox of post rows", () => {
    const posts = [
      summary({ id: "p1", title: "First" }),
      summary({ id: "p2", title: "Second", target: "x", language: "ja", status: "draft" }),
    ];
    const { getByPlaceholderText, getByLabelText, getByText } = render(
      <PostPickerList {...state({ posts })} onSelect={vi.fn()} />,
    );
    expect(getByPlaceholderText("Filter posts…")).toBeTruthy();
    const listbox = getByLabelText("Posts");
    expect(listbox.getAttribute("role")).toBe("listbox");
    expect(getByText("First")).toBeTruthy();
    expect(getByText("Second")).toBeTruthy();
    // The sub-line packs target · language · status.
    expect(getByText("x · ja · draft")).toBeTruthy();
  });

  it("falls back through title → excerpt → id for the row label", () => {
    const posts = [
      summary({ id: "p1", title: undefined, excerpt: "from body" }),
      summary({ id: "bare-id", title: undefined, excerpt: undefined, slug: undefined }),
    ];
    const { getByText } = render(<PostPickerList {...state({ posts })} onSelect={vi.fn()} />);
    expect(getByText("from body")).toBeTruthy();
    expect(getByText("bare-id")).toBeTruthy();
  });

  it("shows the empty message when there are no posts and no error", () => {
    const { getByText } = render(<PostPickerList {...state()} onSelect={vi.fn()} />);
    expect(getByText("No posts found")).toBeTruthy();
  });

  it("shows the error instead of the empty message when loading failed", () => {
    const { getByText, queryByText } = render(
      <PostPickerList {...state({ error: "boom" })} onSelect={vi.fn()} />,
    );
    expect(getByText("boom")).toBeTruthy();
    expect(queryByText("No posts found")).toBeNull();
  });
});

describe("PostPickerList — filtering", () => {
  it("forwards typed input to setQuery", () => {
    const setQuery = vi.fn();
    const { getByPlaceholderText } = render(
      <PostPickerList {...state({ setQuery })} onSelect={vi.fn()} />,
    );
    fireEvent.change(getByPlaceholderText("Filter posts…"), { target: { value: "hello" } });
    expect(setQuery).toHaveBeenCalledWith("hello");
  });
});

describe("PostPickerList — selection", () => {
  it("calls onSelect with the id and resolved title when a row is clicked", () => {
    const onSelect = vi.fn();
    const posts = [summary({ id: "p1", title: "Pick me" })];
    const { getByText } = render(<PostPickerList {...state({ posts })} onSelect={onSelect} />);
    fireEvent.click(getByText("Pick me"));
    expect(onSelect).toHaveBeenCalledWith("p1", "Pick me");
  });

  it("commits the cursor row on Enter from the listbox (manual activation)", () => {
    const onSelect = vi.fn();
    const posts = [summary({ id: "p1", title: "Alpha" }), summary({ id: "p2", title: "Beta" })];
    const { getByLabelText } = render(
      <PostPickerList {...state({ posts })} onSelect={onSelect} />,
    );
    const listbox = getByLabelText("Posts");
    // autoActivateFirst rests the *display* cursor on row 0, but the hook's own
    // active index is still unset, so the first ArrowDown enters the list at row
    // 0; a second ArrowDown advances to row 1. Enter then commits that one.
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("p1", "Alpha");

    fireEvent.keyDown(listbox, { key: "ArrowDown" }); // enters at row 0
    fireEvent.keyDown(listbox, { key: "ArrowDown" }); // advances to row 1
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("p2", "Beta");
  });

  it("hands focus from the filter to the listbox on ArrowDown", () => {
    const posts = [summary({ id: "p1", title: "Alpha" })];
    const { getByPlaceholderText, getByLabelText } = render(
      <PostPickerList {...state({ posts })} onSelect={vi.fn()} />,
    );
    const input = getByPlaceholderText("Filter posts…");
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getByLabelText("Posts"));
  });
});

describe("PostPickerList — load more", () => {
  it("shows a non-tabbable Load More button when hasMore, and invokes loadMore on click", () => {
    const loadMore = vi.fn();
    const posts = [summary({ id: "p1", title: "Alpha" })];
    const { getByText } = render(
      <PostPickerList {...state({ posts, hasMore: true, loadMore })} onSelect={vi.fn()} />,
    );
    const btn = getByText("Load More") as HTMLButtonElement;
    expect(btn.tabIndex).toBe(-1);
    fireEvent.click(btn);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("disables the Load More button and relabels it while a fetch is in flight", () => {
    const posts = [summary({ id: "p1", title: "Alpha" })];
    const { getByText } = render(
      <PostPickerList
        {...state({ posts, hasMore: true, loadingMore: true })}
        onSelect={vi.fn()}
      />,
    );
    const btn = getByText("Loading…") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("omits Load More when there is nothing more to fetch", () => {
    const posts = [summary({ id: "p1", title: "Alpha" })];
    const { queryByText } = render(
      <PostPickerList {...state({ posts, hasMore: false })} onSelect={vi.fn()} />,
    );
    expect(queryByText("Load More")).toBeNull();
  });
});

describe("PostPickerList — autoFocus", () => {
  it("focuses the filter input when autoFocus is set", () => {
    const { getByPlaceholderText } = render(
      <PostPickerList {...state()} onSelect={vi.fn()} autoFocus />,
    );
    expect(document.activeElement).toBe(getByPlaceholderText("Filter posts…"));
  });
});

// A small guard that the active-row highlight reflects the keyboard cursor.
describe("PostPickerList — active highlight", () => {
  it("marks the first row active by default and moves the highlight as the cursor advances", () => {
    const posts = [summary({ id: "p1", title: "Alpha" }), summary({ id: "p2", title: "Beta" })];
    const { getByLabelText, getByText } = render(
      <PostPickerList {...state({ posts })} onSelect={vi.fn()} />,
    );
    const row = (label: string) =>
      getByText(label).closest(".post-picker-item") as HTMLElement;
    // autoActivateFirst rests the highlight on row 0.
    expect(row("Alpha").className).toContain("active");
    expect(row("Beta").className).not.toContain("active");

    // The first ArrowDown enters at row 0; a second advances to row 1.
    const listbox = getByLabelText("Posts");
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(within(row("Beta")).getByText("Beta")).toBeTruthy();
    expect(row("Beta").className).toContain("active");
    expect(row("Alpha").className).not.toContain("active");
  });
});
