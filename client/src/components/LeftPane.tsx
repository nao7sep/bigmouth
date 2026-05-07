import { useEffect, useRef, useState } from "react";
import type { PostSummary } from "../types";
import { getPostTitle } from "../util/postTitle";

interface LeftPaneProps {
  drafts: PostSummary[];
  ready: PostSummary[];
  published: PostSummary[];
  publishedTotal: number;
  selectedPostId: string | null;
  onSelectPost: (id: string) => void;
  onNewPost: () => void;
  onLoadMorePublished: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  onSwitchWorkspace: () => void;
  workspaceName: string;
}

export function LeftPane({
  drafts,
  ready,
  published,
  publishedTotal,
  selectedPostId,
  onSelectPost,
  onNewPost,
  onLoadMorePublished,
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
  onSwitchWorkspace,
  workspaceName,
}: LeftPaneProps) {
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [readyOpen, setReadyOpen] = useState(true);
  const [publishedOpen, setPublishedOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div className="pane-left">
      <div className="left-header">
        <h1>
          BigMouth
          <div className="left-header-actions">
            <button className="btn-new-post-icon" title="New Post" onClick={onNewPost}>
              <span className="plus-icon"><span /><span /></span>
            </button>
            <div className="hamburger-wrap" ref={menuRef}>
              <button
                className="btn-hamburger"
                title="Menu"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <span className="hamburger-icon">
                  <span /><span /><span />
                </span>
              </button>
              {menuOpen && (
                <div className="hamburger-menu">
                  <div className="hamburger-menu-workspace">{workspaceName}</div>
                  <button
                    className="hamburger-menu-item"
                    onClick={() => { setMenuOpen(false); onSwitchWorkspace(); }}
                  >
                    Workspaces
                  </button>
                  <button
                    className="hamburger-menu-item"
                    onClick={() => { setMenuOpen(false); onOpenSettings(); }}
                  >
                    Settings
                  </button>
                  <button
                    className="hamburger-menu-item"
                    onClick={() => { setMenuOpen(false); onOpenShortcuts(); }}
                  >
                    Keyboard Shortcuts
                  </button>
                  <button
                    className="hamburger-menu-item"
                    onClick={() => { setMenuOpen(false); onOpenAbout(); }}
                  >
                    About
                  </button>
                </div>
              )}
            </div>
          </div>
        </h1>
      </div>

      <div className="left-sections">
        <Section
          label="Drafts"
          count={drafts.length}
          open={draftsOpen}
          onToggle={() => setDraftsOpen(!draftsOpen)}
          posts={drafts}
          selectedPostId={selectedPostId}
          onSelectPost={onSelectPost}
          emptyText="No drafts"
          timestampField="updatedAtUtc"
        />

        <Section
          label="Ready"
          count={ready.length}
          open={readyOpen}
          onToggle={() => setReadyOpen(!readyOpen)}
          posts={ready}
          selectedPostId={selectedPostId}
          onSelectPost={onSelectPost}
          emptyText="No ready posts"
          timestampField="readyAtUtc"
        />

        <Section
          label="Published"
          count={published.length}
          totalCount={publishedTotal}
          open={publishedOpen}
          onToggle={() => setPublishedOpen(!publishedOpen)}
          posts={published}
          selectedPostId={selectedPostId}
          onSelectPost={onSelectPost}
          emptyText="No published posts"
          timestampField="publishedAtUtc"
          onLoadMore={
            published.length < publishedTotal ? onLoadMorePublished : undefined
          }
        />
      </div>
    </div>
  );
}

// --- Section sub-component ---

interface SectionProps {
  label: string;
  count: number;
  totalCount?: number;
  open: boolean;
  onToggle: () => void;
  posts: PostSummary[];
  selectedPostId: string | null;
  onSelectPost: (id: string) => void;
  emptyText: string;
  timestampField: string;
  onLoadMore?: () => void;
}

function Section({
  label,
  count,
  totalCount,
  open,
  onToggle,
  posts,
  selectedPostId,
  onSelectPost,
  emptyText,
  timestampField,
  onLoadMore,
}: SectionProps) {
  const displayCount =
    totalCount !== undefined ? `${count}/${totalCount}` : String(count);

  return (
    <>
      <div className="section-header" onClick={onToggle}>
        <span>
          {open ? "\u25BC" : "\u25B6"} {label}
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
                onClick={() => onSelectPost(p.frontMatter.id)}
                timestampField={timestampField}
              />
            ))
          )}
          {onLoadMore && (
            <button
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
  onClick,
  timestampField,
}: {
  post: PostSummary;
  selected: boolean;
  onClick: () => void;
  timestampField: string;
}) {
  const fm = post.frontMatter;
  const displayName = getPostTitle(fm);
  const ts = (fm as Record<string, unknown>)[timestampField] as
    | string
    | undefined;

  return (
    <div
      className={`post-item${selected ? " selected" : ""}`}
      onClick={onClick}
    >
      <div className="post-item-title">{displayName}</div>
      <div className="post-item-meta">
        {fm.target}
        {ts && <> &middot; {formatShortDate(ts)}</>}
      </div>
    </div>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
