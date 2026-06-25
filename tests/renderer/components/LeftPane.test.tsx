import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { LeftPane } from "@renderer/components/LeftPane";
import type { PostSummary, PostFrontMatter } from "@shared/types";

afterEach(cleanup);

// jsdom has no layout: the listbox scrolls the active row into view, so stub
// scrollIntoView so arrowing never throws.
beforeEach(() => {
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  }
});

function fm(over: Partial<PostFrontMatter> & { id: string }): PostFrontMatter {
  return {
    target: "blog",
    status: "draft",
    language: "en",
    createdAtUtc: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

function summary(over: Partial<PostFrontMatter> & { id: string }): PostSummary {
  return { frontMatter: fm(over) };
}

function baseProps() {
  return {
    drafts: [] as PostSummary[],
    ready: [] as PostSummary[],
    published: [] as PostSummary[],
    publishedTotal: 0,
    expired: [] as PostSummary[],
    expiredTotal: 0,
    selectedPostId: null as string | null,
    onSelectPost: vi.fn(),
    onNewPost: vi.fn(),
    onLoadMorePublished: vi.fn(),
    onLoadMoreExpired: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onOpenAbout: vi.fn(),
    onRevealCurrentLogFile: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    workspaceName: "My Workspace",
    timezone: "Asia/Tokyo",
  };
}

function renderPane(over: Partial<ReturnType<typeof baseProps>> = {}) {
  const props = { ...baseProps(), ...over };
  const utils = render(<LeftPane {...props} />);
  return { ...utils, props };
}

describe("LeftPane structure", () => {
  it("renders the four sections, drafts/ready open and published/expired collapsed by default", () => {
    const { container } = renderPane({
      drafts: [summary({ id: "d1", title: "Draft One" })],
      ready: [summary({ id: "r1", title: "Ready One" })],
      published: [summary({ id: "p1", title: "Pub One", status: "published" })],
      publishedTotal: 1,
    });
    const headers = container.querySelectorAll(".section-header");
    expect(Array.from(headers).map((h) => h.querySelector("span")?.textContent?.trim())).toEqual([
      "▼ Drafts",
      "▼ Ready",
      "▶ Published",
      "▶ Expired",
    ]);
    // Open sections render their rows; collapsed ones do not.
    expect(screen.getByText("Draft One")).toBeTruthy();
    expect(screen.getByText("Ready One")).toBeTruthy();
    expect(screen.queryByText("Pub One")).toBeNull();
  });

  it("shows a count for plain sections and a loaded/total count for paginated ones", () => {
    const { container } = renderPane({
      drafts: [summary({ id: "d1" }), summary({ id: "d2" })],
      published: [summary({ id: "p1", status: "published" })],
      publishedTotal: 5,
    });
    const counts = Array.from(container.querySelectorAll(".section-count")).map((c) => c.textContent);
    // Drafts: 2 (plain), Ready: 0, Published: 1/5 (paginated), Expired: 0/0.
    expect(counts).toEqual(["2", "0", "1/5", "0/0"]);
  });

  it("shows the empty placeholder text for an open but empty section", () => {
    renderPane();
    expect(screen.getByText("No drafts")).toBeTruthy();
    expect(screen.getByText("No ready posts")).toBeTruthy();
  });
});

describe("LeftPane section toggling", () => {
  it("expands a collapsed section on header click, revealing its rows", () => {
    const { container } = renderPane({
      published: [summary({ id: "p1", title: "Pub One", status: "published" })],
      publishedTotal: 1,
    });
    expect(screen.queryByText("Pub One")).toBeNull();
    const publishedHeader = Array.from(container.querySelectorAll(".section-header")).find((h) =>
      h.textContent?.includes("Published")
    )!;
    fireEvent.click(publishedHeader);
    expect(screen.getByText("Pub One")).toBeTruthy();
  });

  it("collapses an open section on header click, hiding its rows", () => {
    const { container } = renderPane({
      drafts: [summary({ id: "d1", title: "Draft One" })],
    });
    const draftsHeader = Array.from(container.querySelectorAll(".section-header")).find((h) =>
      h.textContent?.includes("Drafts")
    )!;
    fireEvent.click(draftsHeader);
    expect(screen.queryByText("Draft One")).toBeNull();
  });
});

describe("LeftPane post rows", () => {
  it("uses the title fallback chain and shows target plus a formatted timestamp", () => {
    const { container } = renderPane({
      drafts: [
        summary({ id: "d1", title: "", slug: "my-slug" }), // no title -> slug
        summary({ id: "d2", title: "Has Title" }),
      ],
    });
    const titles = Array.from(container.querySelectorAll(".post-item-title")).map((t) => t.textContent);
    expect(titles).toContain("my-slug");
    expect(titles).toContain("Has Title");
    // Drafts use createdAtUtc; formatted in Asia/Tokyo (UTC+9): 2024-01-01 09:00.
    const meta = container.querySelector(".post-item-meta")?.textContent ?? "";
    expect(meta).toContain("blog");
    expect(meta).toContain("2024-01-01 09:00");
  });

  it("marks the selected row with the selected class", () => {
    const { container } = renderPane({
      drafts: [summary({ id: "d1", title: "One" }), summary({ id: "d2", title: "Two" })],
      selectedPostId: "d2",
    });
    const rows = container.querySelectorAll(".post-item");
    expect(rows[0].className).not.toContain("selected");
    expect(rows[1].className).toContain("selected");
  });

  it("commits a selection via onSelectPost when a row is clicked", () => {
    const onSelectPost = vi.fn();
    const { container } = renderPane({
      drafts: [summary({ id: "d1", title: "One" })],
      onSelectPost,
    });
    fireEvent.click(container.querySelector(".post-item")!);
    expect(onSelectPost).toHaveBeenCalledWith("d1");
  });
});

describe("LeftPane listbox keyboard navigation", () => {
  it("arrows the cursor across section boundaries and commits with Enter", () => {
    const onSelectPost = vi.fn();
    const { container } = renderPane({
      drafts: [summary({ id: "d1", title: "Draft One" })],
      ready: [summary({ id: "r1", title: "Ready One" })],
      onSelectPost,
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // First ArrowDown enters the list on the first row (drafts/d1).
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    // A second ArrowDown crosses into the Ready section (r1) — one continuous list.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelectPost).toHaveBeenCalledWith("r1");
  });
});

describe("LeftPane header actions", () => {
  it("fires onNewPost when the new-post button is clicked", () => {
    const onNewPost = vi.fn();
    const { container } = renderPane({ onNewPost });
    fireEvent.click(container.querySelector(".btn-new-post-icon")!);
    expect(onNewPost).toHaveBeenCalledTimes(1);
  });

  it("opens the hamburger menu and wires every item to its callback", () => {
    const handlers = {
      onRevealCurrentLogFile: vi.fn(),
      onSwitchWorkspace: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenShortcuts: vi.fn(),
      onOpenAbout: vi.fn(),
    };
    const { container } = renderPane({ ...handlers, workspaceName: "WS Name" });
    fireEvent.click(container.querySelector(".btn-hamburger")!);
    const menu = screen.getByRole("menu");
    // The workspace name shows as a non-interactive label.
    expect(within(menu).getByText("WS Name")).toBeTruthy();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Reveal Log" }));
    expect(handlers.onRevealCurrentLogFile).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector(".btn-hamburger")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Workspaces" }));
    expect(handlers.onSwitchWorkspace).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector(".btn-hamburger")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector(".btn-hamburger")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Keyboard Shortcuts" }));
    expect(handlers.onOpenShortcuts).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector(".btn-hamburger")!);
    fireEvent.click(screen.getByRole("menuitem", { name: "About" }));
    expect(handlers.onOpenAbout).toHaveBeenCalledTimes(1);
  });
});

describe("LeftPane load-more affordance", () => {
  it("renders a pointer-only Load more button when more published posts exist", () => {
    const { container } = renderPane({
      published: [summary({ id: "p1", status: "published" })],
      publishedTotal: 3,
    });
    // Published starts collapsed; open it to reveal the load-more button.
    const publishedHeader = Array.from(container.querySelectorAll(".section-header")).find((h) =>
      h.textContent?.includes("Published")
    )!;
    fireEvent.click(publishedHeader);
    const loadMore = screen.getByRole("button", { name: "Load more..." });
    expect(loadMore.getAttribute("tabindex")).toBe("-1");
  });

  it("invokes onLoadMorePublished when the Load more button is clicked", () => {
    const onLoadMorePublished = vi.fn();
    const { container } = renderPane({
      published: [summary({ id: "p1", status: "published" })],
      publishedTotal: 3,
      onLoadMorePublished,
    });
    const publishedHeader = Array.from(container.querySelectorAll(".section-header")).find((h) =>
      h.textContent?.includes("Published")
    )!;
    fireEvent.click(publishedHeader);
    fireEvent.click(screen.getByRole("button", { name: "Load more..." }));
    expect(onLoadMorePublished).toHaveBeenCalledTimes(1);
  });

  it("omits the Load more button once everything is loaded", () => {
    const { container } = renderPane({
      published: [summary({ id: "p1", status: "published" })],
      publishedTotal: 1,
    });
    const publishedHeader = Array.from(container.querySelectorAll(".section-header")).find((h) =>
      h.textContent?.includes("Published")
    )!;
    fireEvent.click(publishedHeader);
    expect(screen.queryByRole("button", { name: "Load more..." })).toBeNull();
  });
});

describe("LeftPane auto-load on cursor reaching the archive end", () => {
  it("auto-loads more published when the cursor lands on the last loaded published row", () => {
    const onLoadMorePublished = vi.fn();
    const { container } = renderPane({
      drafts: [summary({ id: "d1", title: "Draft" })],
      published: [
        summary({ id: "p1", title: "Pub 1", status: "published" }),
        summary({ id: "p2", title: "Pub 2", status: "published" }),
      ],
      publishedTotal: 5, // more remain after p2
      onLoadMorePublished,
    });
    // Expand Published so its rows are navigable.
    const publishedHeader = Array.from(container.querySelectorAll(".section-header")).find((h) =>
      h.textContent?.includes("Published")
    )!;
    fireEvent.click(publishedHeader);

    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // End jumps to the last row in the whole list (p2 is the last published, and
    // Expired is empty), which is the last loaded published row -> auto-load.
    fireEvent.keyDown(listbox, { key: "End" });
    expect(onLoadMorePublished).toHaveBeenCalled();
  });

  it("does not auto-load when the cursor is not on the last loaded row of a paginated archive", () => {
    const onLoadMorePublished = vi.fn();
    const { container } = renderPane({
      drafts: [summary({ id: "d1", title: "Draft" })],
      published: [
        summary({ id: "p1", title: "Pub 1", status: "published" }),
        summary({ id: "p2", title: "Pub 2", status: "published" }),
      ],
      publishedTotal: 5,
      onLoadMorePublished,
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // Cursor enters on the first draft row; not a published archive tail.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(onLoadMorePublished).not.toHaveBeenCalled();
  });
});
