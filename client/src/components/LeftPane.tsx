import { useState } from "react";
import type { PostSummary } from "../types";

interface LeftPaneProps {
  drafts: PostSummary[];
  ready: PostSummary[];
  published: PostSummary[];
  publishedTotal: number;
  selectedPostId: string | null;
  onSelectPost: (id: string) => void;
  onNewPost: () => void;
  onLoadMorePublished: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
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
  searchQuery,
  onSearchChange,
}: LeftPaneProps) {
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [readyOpen, setReadyOpen] = useState(true);
  const [publishedOpen, setPublishedOpen] = useState(false);

  const filter = (posts: PostSummary[]) => {
    if (!searchQuery) return posts;
    const q = searchQuery.toLowerCase();
    return posts.filter((p) => {
      const fm = p.frontMatter;
      return (
        (fm.title && fm.title.toLowerCase().includes(q)) ||
        (fm.slug && fm.slug.toLowerCase().includes(q)) ||
        fm.target.toLowerCase().includes(q) ||
        fm.id.toLowerCase().includes(q) ||
        (fm.tags && fm.tags.some((t) => t.toLowerCase().includes(q)))
      );
    });
  };

  const filteredDrafts = filter(drafts);
  const filteredReady = filter(ready);
  const filteredPublished = filter(published);

  return (
    <div className="pane-left">
      <div className="left-header">
        <h1>
          BigMouth
          <button className="btn-hamburger" title="Menu">
            &#9776;
          </button>
        </h1>
        <button className="btn-new-post" onClick={onNewPost}>
          + New Post
        </button>
        <input
          className="search-box"
          type="text"
          placeholder="Search posts..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>

      <div className="left-sections">
        <Section
          label="Drafts"
          count={filteredDrafts.length}
          open={draftsOpen}
          onToggle={() => setDraftsOpen(!draftsOpen)}
          posts={filteredDrafts}
          selectedPostId={selectedPostId}
          onSelectPost={onSelectPost}
          emptyText="No drafts"
          timestampField="updatedAtUtc"
        />

        <Section
          label="Ready"
          count={filteredReady.length}
          open={readyOpen}
          onToggle={() => setReadyOpen(!readyOpen)}
          posts={filteredReady}
          selectedPostId={selectedPostId}
          onSelectPost={onSelectPost}
          emptyText="No ready posts"
          timestampField="readyAtUtc"
        />

        <Section
          label="Published"
          count={filteredPublished.length}
          totalCount={publishedTotal}
          open={publishedOpen}
          onToggle={() => setPublishedOpen(!publishedOpen)}
          posts={filteredPublished}
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
            <div style={{ padding: "12px 16px", color: "#999", fontSize: 13 }}>
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
                color: "#2563eb",
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
  const displayName = fm.title || fm.slug || fm.id;
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
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hours}:${minutes}`;
}
