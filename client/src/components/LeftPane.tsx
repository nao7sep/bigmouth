import { useEffect, useMemo, useState } from "react";
import type { PostSummary } from "../types";
import { getPostTitle } from "../util/postTitle";
import { formatLocalDateTime } from "../util/timestamps";
import { useComposing } from "../hooks/useComposing";
import { usePostListbox, type PostListRow } from "../hooks/usePostListbox";
import { flatPostListIds } from "../util/compositeNav";
import { Menu, MenuItem } from "./Menu";

// One viewport's worth of rows for PageUp/PageDown. The list scrolls but rows
// are a fixed-ish height; a constant step is the conventional approximation.
const PAGE_SIZE = 10;

interface LeftPaneProps {
  drafts: PostSummary[];
  checked: PostSummary[];
  published: PostSummary[];
  publishedTotal: number;
  selectedPostId: string | null;
  onSelectPost: (id: string) => void;
  onNewPost: () => void;
  onLoadMorePublished: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  onRevealCurrentLogFile: () => Promise<void> | void;
  onSwitchWorkspace: () => void;
  workspaceName: string;
}

interface SectionDef {
  key: string;
  label: string;
  posts: PostSummary[];
  open: boolean;
  toggle: () => void;
  emptyText: string;
  timestampField: string;
  totalCount?: number;
  /** Pointer-only "load more" affordance for this section, if applicable. */
  onLoadMore?: () => void;
}

export function LeftPane({
  drafts,
  checked,
  published,
  publishedTotal,
  selectedPostId,
  onSelectPost,
  onNewPost,
  onLoadMorePublished,
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
  onRevealCurrentLogFile,
  onSwitchWorkspace,
  workspaceName,
}: LeftPaneProps) {
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [checkedOpen, setCheckedOpen] = useState(true);
  const [publishedOpen, setPublishedOpen] = useState(false);
  const { composingRef, handlers } = useComposing();

  const sections: SectionDef[] = [
    {
      key: "drafts",
      label: "Drafts",
      posts: drafts,
      open: draftsOpen,
      toggle: () => setDraftsOpen((v) => !v),
      emptyText: "No drafts",
      timestampField: "createdAtUtc",
    },
    {
      key: "checked",
      label: "Checked",
      posts: checked,
      open: checkedOpen,
      toggle: () => setCheckedOpen((v) => !v),
      emptyText: "No checked posts",
      timestampField: "createdAtUtc",
    },
    {
      key: "published",
      label: "Published",
      posts: published,
      open: publishedOpen,
      toggle: () => setPublishedOpen((v) => !v),
      emptyText: "No published posts",
      timestampField: "publishedAtUtc",
      totalCount: publishedTotal,
      onLoadMore:
        published.length < publishedTotal ? onLoadMorePublished : undefined,
    },
  ];

  // The three sections are ONE listbox: arrow navigation flows continuously
  // across them over exactly the currently-rendered rows. Collapsed sections
  // contribute no navigable rows.
  const rows: PostListRow[] = useMemo(
    () =>
      flatPostListIds(
        sections.map((s) => ({ open: s.open, items: s.posts })),
      ).map((p) => ({ id: p.frontMatter.id, label: getPostTitle(p.frontMatter) })),
    // sections is rebuilt each render from these inputs; depend on the inputs.
    [drafts, checked, published, draftsOpen, checkedOpen, publishedOpen],
  );

  const { listboxProps, getRowProps, activeId } = usePostListbox({
    rows,
    selectedId: selectedPostId,
    onActivate: onSelectPost,
    pageSize: PAGE_SIZE,
    composingRef,
  });

  // Auto-load more published posts as the cursor reaches the end of the loaded
  // set — the conventions' "load more automatically at the end" for a control
  // whose load-more affordance is not a tab stop. The pointer-only button below
  // remains for discoverability.
  const lastRowId = rows.length > 0 ? rows[rows.length - 1].id : null;
  const canLoadMore = published.length < publishedTotal;
  useEffect(() => {
    if (canLoadMore && activeId != null && activeId === lastRowId) {
      onLoadMorePublished();
    }
  }, [activeId, lastRowId, canLoadMore, onLoadMorePublished]);

  return (
    <div className="pane-left">
      <div className="left-header">
        <h1>
          BigMouth
          <div className="left-header-actions">
            <button className="btn-new-post-icon" title="New Post" onClick={onNewPost}>
              <span className="plus-icon"><span /><span /></span>
            </button>
            <Menu
              label="Menu"
              trigger={(props) => (
                <button className="btn-hamburger" title="Menu" {...props}>
                  <span className="hamburger-icon">
                    <span /><span /><span />
                  </span>
                </button>
              )}
            >
              <div className="menu-label">{workspaceName}</div>
              <MenuItem onSelect={() => void onRevealCurrentLogFile()}>Reveal Log</MenuItem>
              <MenuItem onSelect={onSwitchWorkspace}>Workspaces</MenuItem>
              <MenuItem onSelect={onOpenSettings}>Settings</MenuItem>
              <MenuItem onSelect={onOpenShortcuts}>Keyboard Shortcuts</MenuItem>
              <MenuItem onSelect={onOpenAbout}>About</MenuItem>
            </Menu>
          </div>
        </h1>
      </div>

      <div
        className="left-sections"
        aria-label="Posts"
        {...listboxProps}
      >
        {sections.map((section) => (
          <Section
            key={section.key}
            section={section}
            selectedPostId={selectedPostId}
            activeId={activeId}
            getRowProps={getRowProps}
            composing={handlers}
          />
        ))}
      </div>
    </div>
  );
}

// --- Section sub-component ---

function Section({
  section,
  selectedPostId,
  activeId,
  getRowProps,
  composing,
}: {
  section: SectionDef;
  selectedPostId: string | null;
  activeId: string | null;
  getRowProps: ReturnType<typeof usePostListbox>["getRowProps"];
  composing: ReturnType<typeof useComposing>["handlers"];
}) {
  const { label, posts, open, toggle, emptyText, timestampField, totalCount, onLoadMore } =
    section;
  const displayCount =
    totalCount !== undefined ? `${posts.length}/${totalCount}` : String(posts.length);

  return (
    <>
      {/* Group header: a non-interactive label, not a tab stop. The collapse
          toggle is pointer-only (click the header). */}
      <div className="section-header" role="group" onClick={toggle}>
        <span>
          {open ? "▼" : "▶"} {label}
        </span>
        <span className="section-count">{displayCount}</span>
      </div>
      {open && (
        <div className="section-items">
          {posts.length === 0 ? (
            <div style={{ padding: "12px 16px", color: "var(--bm-text-faint)", fontSize: 13 }}>
              {emptyText}
            </div>
          ) : (
            posts.map((p) => (
              <PostItem
                key={p.frontMatter.id}
                post={p}
                selected={p.frontMatter.id === selectedPostId}
                active={p.frontMatter.id === activeId}
                rowProps={getRowProps(p.frontMatter.id)}
                composing={composing}
                timestampField={timestampField}
              />
            ))
          )}
          {onLoadMore && (
            <button
              // Pointer-only: not a tab stop, so it never breaks the listbox's
              // single tab stop. Keyboard users reach more posts by arrowing to
              // the end, which auto-loads.
              tabIndex={-1}
              onClick={onLoadMore}
              style={{
                width: "100%",
                padding: "8px",
                background: "none",
                border: "none",
                color: "var(--bm-accent)",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Load more...
            </button>
          )}
        </div>
      )}
    </>
  );
}

// --- PostItem sub-component ---

function PostItem({
  post,
  selected,
  active,
  rowProps,
  composing,
  timestampField,
}: {
  post: PostSummary;
  selected: boolean;
  active: boolean;
  rowProps: ReturnType<ReturnType<typeof usePostListbox>["getRowProps"]>;
  composing: ReturnType<typeof useComposing>["handlers"];
  timestampField: string;
}) {
  const fm = post.frontMatter;
  const displayName = getPostTitle(fm);
  const ts = (fm as Record<string, unknown>)[timestampField] as string | undefined;

  return (
    <div
      className={`post-item${selected ? " selected" : ""}${active ? " active" : ""}`}
      onCompositionStart={composing.onCompositionStart}
      onCompositionEnd={composing.onCompositionEnd}
      {...rowProps}
    >
      <div className="post-item-title">{displayName}</div>
      <div className="post-item-meta">
        {fm.target}
        {ts && <> &middot; {formatLocalDateTime(ts)}</>}
      </div>
    </div>
  );
}
