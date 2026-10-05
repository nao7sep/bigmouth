import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { LeftPane } from "@renderer/components/LeftPane";
import type { PostStatus, PostSummary, PostFrontMatter } from "@shared/types";
import { emptyPostLists } from "@renderer/util/postBuckets";

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
    selectedPostId: null as string | null,
    onSelectPost: vi.fn(),
    onNewPost: vi.fn(),
    onLoadMore: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenShortcuts: vi.fn(),
    onOpenAbout: vi.fn(),
    onOpenRecords: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    workspaceName: "My Workspace",
    timezone: "Asia/Tokyo",
  };
}

type Over = Partial<ReturnType<typeof baseProps>> & {
  /** Each section's loaded posts. */
  sections?: Partial<Record<PostStatus, PostSummary[]>>;
  /** A paged section's total, when more exist than are loaded. */
  totals?: Partial<Record<PostStatus, number>>;
};

function renderPane({ sections = {}, totals = {}, ...over }: Over = {}) {
  const lists = emptyPostLists();
  for (const status of Object.keys(lists) as PostStatus[]) {
    const posts = sections[status] ?? [];
    lists[status] = { posts, total: totals[status] ?? posts.length };
  }
  const props = { ...baseProps(), ...over, lists };
  const utils = render(<LeftPane {...props} />);
  return { ...utils, props };
}

const findHeader = (container: HTMLElement, name: string) =>
  Array.from(container.querySelectorAll(".section-header")).find((h) => h.textContent?.includes(name))!;

const PAGED = [
  ["discarded", "Discarded"],
  ["published", "Published"],
  ["retired", "Retired"],
] as const;

describe("LeftPane structure", () => {
  it("renders a section per status in status order, drafts and verified open, the paged ones collapsed", () => {
    const { container } = renderPane({
      sections: {
        draft: [summary({ id: "d1", title: "Draft One" })],
        verified: [summary({ id: "v1", title: "Verified One", status: "verified" })],
        published: [summary({ id: "p1", title: "Pub One", status: "published" })],
      },
    });
    const headers = container.querySelectorAll(".section-header");
    expect(Array.from(headers).map((h) => h.querySelector("span")?.textContent?.trim())).toEqual([
      "Drafts",
      "Discarded",
      "Verified",
      "Published",
      "Retired",
    ]);
    // Open versus collapsed is carried by which chevron renders, the icons being
    // aria-hidden and so invisible to a text assertion.
    expect(Array.from(headers).map((h) => h.querySelector("svg")?.dataset.icon)).toEqual([
      "chevron-down",
      "chevron-right",
      "chevron-down",
      "chevron-right",
      "chevron-right",
    ]);
    // Open sections render their rows; collapsed ones do not.
    expect(screen.getByText("Draft One")).toBeTruthy();
    expect(screen.getByText("Verified One")).toBeTruthy();
    expect(screen.queryByText("Pub One")).toBeNull();
  });

  it("shows a count for whole sections and a loaded/total count for paged ones", () => {
    const { container } = renderPane({
      sections: {
        draft: [summary({ id: "d1" }), summary({ id: "d2" })],
        published: [summary({ id: "p1", status: "published" })],
      },
      totals: { published: 5, discarded: 3 },
    });
    const counts = Array.from(container.querySelectorAll(".section-count")).map((c) => c.textContent);
    expect(counts).toEqual(["2", "0/3", "0", "1/5", "0/0"]);
  });

  it("shows the empty placeholder text for an open but empty section", () => {
    const { container } = renderPane();
    expect(screen.getByText("No drafts")).toBeTruthy();
    expect(screen.getByText("No verified posts")).toBeTruthy();
    fireEvent.click(findHeader(container, "Discarded"));
    fireEvent.click(findHeader(container, "Retired"));
    expect(screen.getByText("No discarded posts")).toBeTruthy();
    expect(screen.getByText("No retired posts")).toBeTruthy();
  });
});

describe("LeftPane section toggling", () => {
  it.each(PAGED)("expands the collapsed %s section on header click, revealing its rows", (status, label) => {
    const { container } = renderPane({ sections: { [status]: [summary({ id: "x1", title: "Row One", status })] } });
    expect(screen.queryByText("Row One")).toBeNull();
    fireEvent.click(findHeader(container, label));
    expect(screen.getByText("Row One")).toBeTruthy();
  });

  it("collapses an open section on header click, hiding its rows", () => {
    const { container } = renderPane({ sections: { draft: [summary({ id: "d1", title: "Draft One" })] } });
    fireEvent.click(findHeader(container, "Drafts"));
    expect(screen.queryByText("Draft One")).toBeNull();
  });
});

describe("LeftPane post rows", () => {
  it("uses the title fallback chain and shows target plus a formatted timestamp", () => {
    const { container } = renderPane({
      sections: {
        draft: [
          summary({ id: "d1", title: "", slug: "my-slug" }), // no title -> slug
          summary({ id: "d2", title: "Has Title" }),
        ],
      },
    });
    const titles = Array.from(container.querySelectorAll(".post-item-title")).map((t) => t.textContent);
    expect(titles).toContain("my-slug");
    expect(titles).toContain("Has Title");
    // Drafts use createdAtUtc, formatted in Asia/Tokyo (UTC+9) with the
    // interface language's format (English outside a provider).
    const meta = container.querySelector(".post-item-meta")?.textContent ?? "";
    expect(meta).toContain("blog");
    expect(meta).toContain("Jan 1, 2024, 9:00 AM");
  });

  it.each([
    ["discarded", "Discarded", "discardedAtUtc"],
    ["published", "Published", "publishedAtUtc"],
    ["retired", "Retired", "retiredAtUtc"],
  ] as const)("shows a %s post's own status time", (status, label, key) => {
    const { container } = renderPane({
      sections: { [status]: [summary({ id: "x1", status, [key]: "2024-06-01T03:00:00.000Z" })] },
    });
    fireEvent.click(findHeader(container, label));
    expect(container.querySelector(".post-item-meta")?.textContent).toContain("Jun 1, 2024, 12:00 PM");
  });

  it("marks the selected row with the selected class", () => {
    const { container } = renderPane({
      sections: { draft: [summary({ id: "d1", title: "One" }), summary({ id: "d2", title: "Two" })] },
      selectedPostId: "d2",
    });
    const rows = container.querySelectorAll(".post-item");
    expect(rows[0].className).not.toContain("selected");
    expect(rows[1].className).toContain("selected");
  });

  it("commits a selection via onSelectPost when a row is clicked", () => {
    const onSelectPost = vi.fn();
    const { container } = renderPane({ sections: { draft: [summary({ id: "d1", title: "One" })] }, onSelectPost });
    fireEvent.click(container.querySelector(".post-item")!);
    expect(onSelectPost).toHaveBeenCalledWith("d1");
  });
});

describe("LeftPane listbox keyboard navigation", () => {
  it("arrows the cursor across section boundaries and commits with Enter", () => {
    const onSelectPost = vi.fn();
    const { container } = renderPane({
      sections: {
        draft: [summary({ id: "d1", title: "Draft One" })],
        verified: [summary({ id: "v1", title: "Verified One", status: "verified" })],
      },
      onSelectPost,
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // Each section's summary row is part of the sequence, so the rows here are
    // [Drafts] d1 [Discarded] [Verified] v1 — one continuous list crossing
    // group boundaries.
    for (let i = 0; i < 5; i++) fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelectPost).toHaveBeenCalledWith("v1");
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
      onOpenRecords: vi.fn(),
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

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Records" }));
    expect(handlers.onOpenRecords).toHaveBeenCalledTimes(1);

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
    fireEvent.click(screen.getByRole("menuitem", { name: "About BigMouth" }));
    expect(handlers.onOpenAbout).toHaveBeenCalledTimes(1);
  });
});

describe("LeftPane load-more affordance", () => {
  it.each(PAGED)("renders a pointer-only Load more button when more %s posts exist", (status, label) => {
    const { container } = renderPane({
      sections: { [status]: [summary({ id: "x1", status })] },
      totals: { [status]: 3 },
    });
    // Paged sections start collapsed; open it to reveal the load-more button.
    fireEvent.click(findHeader(container, label));
    const loadMore = screen.getByRole("button", { name: "Load more…" });
    expect(loadMore.getAttribute("tabindex")).toBe("-1");
  });

  it.each(PAGED)("asks for more %s posts when its Load more button is clicked", (status, label) => {
    const onLoadMore = vi.fn();
    const { container } = renderPane({
      sections: { [status]: [summary({ id: "x1", status })] },
      totals: { [status]: 3 },
      onLoadMore,
    });
    fireEvent.click(findHeader(container, label));
    fireEvent.click(screen.getByRole("button", { name: "Load more…" }));
    expect(onLoadMore).toHaveBeenCalledExactlyOnceWith(status);
  });

  it("omits the Load more button once everything is loaded", () => {
    const { container } = renderPane({ sections: { published: [summary({ id: "p1", status: "published" })] } });
    fireEvent.click(findHeader(container, "Published"));
    expect(screen.queryByRole("button", { name: "Load more…" })).toBeNull();
  });
});

describe("LeftPane auto-load on cursor reaching a paged section's end", () => {
  it("auto-loads more published when the cursor lands on the last loaded published row", () => {
    const onLoadMore = vi.fn();
    const { container } = renderPane({
      sections: {
        draft: [summary({ id: "d1", title: "Draft" })],
        published: [
          summary({ id: "p1", title: "Pub 1", status: "published" }),
          summary({ id: "p2", title: "Pub 2", status: "published" }),
        ],
      },
      totals: { published: 5 }, // more remain after p2
      onLoadMore,
    });
    fireEvent.click(findHeader(container, "Published"));

    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // End lands on the Retired summary row — the genuine end of the list — so
    // step up once onto p2, the last loaded published row, to trigger auto-load.
    fireEvent.keyDown(listbox, { key: "End" });
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(onLoadMore).toHaveBeenCalledExactlyOnceWith("published");
  });

  it("auto-loads more discarded when the cursor lands on the last loaded discarded row", () => {
    const onLoadMore = vi.fn();
    const { container } = renderPane({
      sections: { discarded: [summary({ id: "x1", title: "Disc 1", status: "discarded" })] },
      totals: { discarded: 4 },
      onLoadMore,
    });
    fireEvent.click(findHeader(container, "Discarded"));

    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // Rows: [Drafts] [Discarded] x1 — the third row.
    for (let i = 0; i < 3; i++) fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(onLoadMore).toHaveBeenCalledExactlyOnceWith("discarded");
  });

  it("does not auto-load when the cursor is not on the last loaded row of a paged section", () => {
    const onLoadMore = vi.fn();
    const { container } = renderPane({
      sections: {
        draft: [summary({ id: "d1", title: "Draft" })],
        published: [
          summary({ id: "p1", title: "Pub 1", status: "published" }),
          summary({ id: "p2", title: "Pub 2", status: "published" }),
        ],
      },
      totals: { published: 5 },
      onLoadMore,
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // Cursor enters on the first draft row; not a paged section's tail.
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});

describe("LeftPane collapsed sections are reachable by keyboard", () => {
  // A collapsed section renders none of its posts, so if its summary row could
  // not be reached and toggled from the keyboard, those posts would be
  // unreachable entirely — not merely unannounced.
  it("announces collapsed and expanded state on each summary row", () => {
    const { container } = renderPane({ sections: { published: [summary({ id: "p1", status: "published" })] } });
    expect(findHeader(container, "Drafts").getAttribute("aria-expanded")).toBe("true");
    expect(findHeader(container, "Published").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(findHeader(container, "Published"));
    expect(findHeader(container, "Published").getAttribute("aria-expanded")).toBe("true");
  });

  it("expands a collapsed section with Enter on its summary row", () => {
    const { container } = renderPane({
      sections: { published: [summary({ id: "p1", title: "Pub One", status: "published" })] },
    });
    expect(screen.queryByText("Pub One")).toBeNull();
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    // Rows: [Drafts] [Discarded] [Verified] [Published] [Retired] — every
    // section empty or collapsed, so End lands on Retired and one step up is
    // Published.
    fireEvent.keyDown(listbox, { key: "End" });
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(screen.getByText("Pub One")).toBeTruthy();
  });

  it("expands with Right and collapses with Left, and leaves post rows alone", () => {
    const { container } = renderPane({
      sections: {
        draft: [summary({ id: "d1", title: "Draft One" })],
        published: [summary({ id: "p1", title: "Pub One", status: "published" })],
      },
    });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    fireEvent.keyDown(listbox, { key: "End" });
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    expect(screen.getByText("Pub One")).toBeTruthy();
    fireEvent.keyDown(listbox, { key: "ArrowLeft" });
    expect(screen.queryByText("Pub One")).toBeNull();

    // Right on a post row is inert: it neither toggles nor moves the cursor.
    fireEvent.keyDown(listbox, { key: "Home" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowRight" });
    expect(screen.getByText("Draft One")).toBeTruthy();
  });

  it("toggles rather than selecting when Enter lands on a summary row", () => {
    const onSelectPost = vi.fn();
    const { container } = renderPane({ sections: { draft: [summary({ id: "d1", title: "Draft One" })] }, onSelectPost });
    const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
    fireEvent.keyDown(listbox, { key: "Home" });
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onSelectPost).not.toHaveBeenCalled();
    expect(screen.queryByText("Draft One")).toBeNull();
  });
});
