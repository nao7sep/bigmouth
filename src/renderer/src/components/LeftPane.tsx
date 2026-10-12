import { useEffect, useMemo, useState } from "react";
import type { PostStatus, PostSummary } from "@shared/types";
import { PAGED_POST_STATUSES, POST_STATUSES, isPagedPostStatus, type PagedPostStatus } from "@shared/postStatus";
import { LIST_TIME_KEY, type ListTimeKey } from "@shared/postOrder";
import type { MessageKey } from "@shared/i18n/catalogues";
import type { PostLists } from "../util/postBuckets";
import { getPostTitle } from "../util/postTitle";
import { formatLocalDateTime } from "../util/timestamps";
import { ChevronDownIcon, ChevronRightIcon, MenuIcon, PlusIcon } from "./Icon";
import { useComposing } from "../hooks/useComposing";
import { usePostListbox, type PostListRow } from "../hooks/usePostListbox";
import { Menu, MenuItem } from "./Menu";
import { useI18n } from "../i18n/I18nContext";

// One viewport's worth of rows for PageUp/PageDown. The list scrolls but rows
// are a fixed-ish height; a constant step is the conventional approximation.
/** Row id for a section's summary row, namespaced away from post ids. */
function sectionRowId(key: string): string {
  return `section:${key}`;
}

const PAGE_SIZE = 10;

/** Each section's heading and empty-state text. */
const SECTION_TEXT: Readonly<Record<PostStatus, { label: MessageKey; empty: MessageKey }>> = {
  draft: { label: "left.drafts", empty: "left.noDrafts" },
  discarded: { label: "left.discarded", empty: "left.noDiscarded" },
  verified: { label: "left.verified", empty: "left.noVerified" },
  published: { label: "left.published", empty: "left.noPublished" },
  retired: { label: "left.retired", empty: "left.noRetired" },
};

// Sections open at launch: the ones still being worked on. The paged ones,
// which can be long, start collapsed.
const INITIALLY_OPEN: ReadonlySet<PostStatus> = new Set(["draft", "verified"]);

interface LeftPaneProps {
  lists: PostLists;
  selectedPostId: string | null;
  onSelectPost: (id: string) => void;
  onNewPost: () => void;
  onLoadMore: (status: PagedPostStatus) => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenAbout: () => void;
  onOpenRecords: () => Promise<void> | void;
  onSwitchWorkspace: () => void;
  workspaceName: string;
  timezone: string;
}

interface SectionDef {
  key: PostStatus;
  label: string;
  posts: PostSummary[];
  open: boolean;
  emptyText: string;
  timestampField: ListTimeKey;
  totalCount?: number;
  /** Pointer-only "load more" affordance for this section, if applicable. */
  onLoadMore?: () => void;
}

export function LeftPane({
  lists,
  selectedPostId,
  onSelectPost,
  onNewPost,
  onLoadMore,
  onOpenSettings,
  onOpenShortcuts,
  onOpenAbout,
  onOpenRecords,
  onSwitchWorkspace,
  workspaceName,
  timezone,
}: LeftPaneProps) {
  const { t } = useI18n();
  const [openSections, setOpenSections] = useState<ReadonlySet<PostStatus>>(INITIALLY_OPEN);
  const { composingRef, handlers } = useComposing();

  const toggleSection = (status: PostStatus) =>
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });

  const sections: SectionDef[] = POST_STATUSES.map((status) => {
    const { posts, total } = lists[status];
    const paged = isPagedPostStatus(status);
    return {
      key: status,
      label: t(SECTION_TEXT[status].label),
      posts,
      open: openSections.has(status),
      emptyText: t(SECTION_TEXT[status].empty),
      timestampField: LIST_TIME_KEY[status],
      ...(paged
        ? {
            totalCount: total,
            onLoadMore: posts.length < total ? () => onLoadMore(status) : undefined,
          }
        : {}),
    };
  });

  // The sections are ONE listbox: arrow navigation flows continuously
  // across them over exactly the currently-rendered rows. Each section's summary
  // row is part of that sequence — carrying `expanded`, toggled with Enter/Space
  // or Right/Left — which is the only keyboard route into a collapsed section. A
  // collapsed section still contributes no post rows.
  const rows: PostListRow[] = useMemo(
    () =>
      sections.flatMap((s) => [
        { id: sectionRowId(s.key), label: s.label, expanded: s.open },
        ...(s.open
          ? s.posts.map((p) => ({
              id: p.frontMatter.id,
              label: getPostTitle(p.frontMatter),
            }))
          : []),
      ]),
    // sections is rebuilt each render from these inputs; depend on the inputs.
    [lists, openSections, t],
  );

  const statusByRowId = useMemo(
    () => new Map(POST_STATUSES.map((status) => [sectionRowId(status), status])),
    [],
  );

  const { listboxProps, getRowProps, activeId } = usePostListbox({
    rows,
    selectedId: selectedPostId,
    onActivate: onSelectPost,
    onToggleRow: (id) => {
      const status = statusByRowId.get(id);
      if (status) toggleSection(status);
    },
    pageSize: PAGE_SIZE,
    composingRef,
  });

  // Auto-load more of a paged section as the cursor reaches the end of that
  // section's loaded set — the conventions' "load more automatically at the
  // end" for a control whose load-more affordance is not a tab stop. Each paged
  // section triggers on its own last loaded row, since none of them is the
  // global tail. The pointer-only buttons below remain for discoverability.
  const loadMoreStatus =
    activeId === null
      ? null
      : (PAGED_POST_STATUSES.find((status) => {
          const { posts, total } = lists[status];
          return (
            openSections.has(status) &&
            posts.length > 0 &&
            posts.length < total &&
            posts[posts.length - 1].frontMatter.id === activeId
          );
        }) ?? null);
  useEffect(() => {
    if (loadMoreStatus !== null) onLoadMore(loadMoreStatus);
  }, [activeId, loadMoreStatus, onLoadMore]);

  return (
    <div className="pane-left">
      <div className="left-header">
        <h1>
          BigMouth
          <div className="left-header-actions">
            <button className="btn-new-post-icon" title={t("left.newPost")} onClick={onNewPost}>
              <PlusIcon />
            </button>
            <Menu
              label={t("left.menu")}
              trigger={(props) => (
                <button className="btn-hamburger" title={t("left.menu")} {...props}>
                  <MenuIcon />
                </button>
              )}
            >
              <div className="menu-label">{workspaceName}</div>
              <MenuItem onSelect={onSwitchWorkspace}>{t("workspaces.title")}</MenuItem>
              <MenuItem onSelect={onOpenSettings}>{t("settings.title")}</MenuItem>
              <MenuItem onSelect={() => void onOpenRecords()}>{t("left.records")}</MenuItem>
              <MenuItem onSelect={onOpenShortcuts}>{t("shortcuts.title")}</MenuItem>
              <MenuItem onSelect={onOpenAbout}>{t("left.about")}</MenuItem>
            </Menu>
          </div>
        </h1>
      </div>

      <div
        className="left-sections"
        aria-label={t("left.posts")}
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
            timezone={timezone}
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
  timezone,
}: {
  section: SectionDef;
  selectedPostId: string | null;
  activeId: string | null;
  getRowProps: ReturnType<typeof usePostListbox>["getRowProps"];
  composing: ReturnType<typeof useComposing>["handlers"];
  timezone: string;
}) {
  const { t, number } = useI18n();
  const { key: sectionKey, label, posts, open, emptyText, timestampField, totalCount, onLoadMore } =
    section;
  const displayCount =
    totalCount !== undefined
      ? t("left.shownOfTotal", { shown: posts.length, total: totalCount })
      : number(posts.length);

  return (
    <>
      {/* The section's summary row: part of the listbox's row sequence, never a
          tab stop of its own. Arrowing onto it and pressing Enter/Space (or
          Right/Left) toggles the section, which is the only keyboard route into
          a collapsed one. */}
      <div
        className={`section-header${activeId === sectionRowId(sectionKey) ? " active" : ""}`}
        {...getRowProps(sectionRowId(sectionKey))}
      >
        <span>
          {open ? <ChevronDownIcon /> : <ChevronRightIcon />} {label}
        </span>
        <span className="section-count">{displayCount}</span>
      </div>
      {open && (
        <div className="section-items">
          {posts.length === 0 ? (
            <div className="section-empty">{emptyText}</div>
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
                timezone={timezone}
              />
            ))
          )}
          {onLoadMore && (
            <button
              // Pointer-only: not a tab stop, so it never breaks the listbox's
              // single tab stop. Keyboard users reach more posts by arrowing to
              // the end, which auto-loads.
              tabIndex={-1}
              className="section-load-more"
              onClick={onLoadMore}
            >
              {t("left.loadMore")}
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
  timezone,
}: {
  post: PostSummary;
  selected: boolean;
  active: boolean;
  rowProps: ReturnType<ReturnType<typeof usePostListbox>["getRowProps"]>;
  composing: ReturnType<typeof useComposing>["handlers"];
  timestampField: ListTimeKey;
  timezone: string;
}) {
  const { dateTime } = useI18n();
  const fm = post.frontMatter;
  const displayName = getPostTitle(fm);
  const ts = fm[timestampField];

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
        {ts && <> &middot; {formatLocalDateTime(ts, timezone, dateTime)}</>}
      </div>
    </div>
  );
}
