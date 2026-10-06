import type { PostListResponse, PostStatus, PostSummary } from "@shared/types";
import { comparatorFor, type OrderablePost } from "@shared/postOrder";
import { POST_STATUSES, isPagedPostStatus } from "@shared/postStatus";

/**
 * One status's list section as the renderer holds it: the posts loaded so far
 * and how many the status holds. A paged section's next page starts at
 * `posts.length`; a section that loads whole has `total` equal to its length.
 */
export interface ListSection {
  posts: PostSummary[];
  total: number;
}

/** The Posts list: one section per status. */
export type PostLists = Record<PostStatus, ListSection>;

export function emptyPostLists(): PostLists {
  const empty = (): ListSection => ({ posts: [], total: 0 });
  return { draft: empty(), discarded: empty(), verified: empty(), published: empty(), retired: empty() };
}

/** The lists a list response describes, every section replaced. */
export function listsFromResponse(response: PostListResponse): PostLists {
  return Object.fromEntries(
    POST_STATUSES.map((status) => [status, { posts: response[status].posts, total: response[status].total }]),
  ) as PostLists;
}

/** The status whose loaded section holds `id`, or null when none does. */
export function loadedStatusOf(lists: PostLists, id: string): PostStatus | null {
  return POST_STATUSES.find((status) => lists[status].posts.some((entry) => entry.frontMatter.id === id)) ?? null;
}

/**
 * Recomputes the sections after a single post mutation: the post moves into
 * the section its new status names and out of wherever it was, and a paged
 * section's total is adjusted for a post entering or leaving it.
 *
 * Pure — no refs, no state setters. The caller applies the returned lists.
 *
 * `openPostStatus` is the status of the currently-open post, but only when that
 * post is the one being mutated AND it is absent from every loaded section (it
 * was reached via a source link, so its previous section is off the loaded
 * page); otherwise null. It is the last-resort source for the previous status
 * when the post cannot be located in a loaded section.
 */
export function applyPostMutationToLists(
  prev: PostLists,
  summary: PostSummary,
  status: PostStatus,
  openPostStatus: PostStatus | null
): PostLists {
  const loadedIn = loadedStatusOf(prev, summary.frontMatter.id);
  const previousStatus = loadedIn ?? openPostStatus;

  const next = {} as PostLists;
  for (const section of POST_STATUSES) {
    if (!isPagedPostStatus(section)) {
      const posts = nextSummariesForStatus(prev[section].posts, summary, section, status === section);
      next[section] = { posts, total: posts.length };
      continue;
    }
    // For a paged section, only fold the post into the loaded page when it is
    // already there or arriving from elsewhere — a re-save of a post in that
    // section but not on the loaded page belongs deeper in it, not the top. A
    // post arriving from elsewhere joins only when it sorts inside the loaded
    // rows, so they stay the section's first rows and the next page, which starts
    // at their count, neither skips a row nor repeats this one.
    const include =
      status === section &&
      (loadedIn === section ||
        (previousStatus !== section && belongsInLoadedRows(prev[section], summary, section)));
    const posts = nextSummariesForStatus(prev[section].posts, summary, section, include);
    let total = prev[section].total;
    if (previousStatus === section && status !== section) {
      total = Math.max(0, total - 1);
    } else if (previousStatus !== null && previousStatus !== section && status === section) {
      total += 1;
    }
    next[section] = { posts, total };
  }
  return next;
}

/**
 * Whether a post entering a paged section sorts among its loaded rows: always
 * when every row is loaded, otherwise only ahead of the last loaded one.
 */
function belongsInLoadedRows(section: ListSection, summary: PostSummary, status: PostStatus): boolean {
  if (section.posts.length >= section.total) return true;
  const last = section.posts[section.posts.length - 1];
  return last !== undefined && compareSummaries(status, summary, last) < 0;
}

/**
 * Removes a deleted post from the section that holds it. Returns null when no
 * loaded section does.
 */
export function removePostFromLists(prev: PostLists, id: string): { lists: PostLists; status: PostStatus } | null {
  const status = loadedStatusOf(prev, id);
  if (status === null) return null;
  const posts = prev[status].posts.filter((entry) => entry.frontMatter.id !== id);
  const total = isPagedPostStatus(status) ? Math.max(0, prev[status].total - 1) : posts.length;
  return { lists: { ...prev, [status]: { posts, total } }, status };
}

/**
 * Returns `current` with the mutated post removed, then re-inserted in sorted
 * position when `include` is true (the post belongs in this status' section).
 */
export function nextSummariesForStatus(
  current: PostSummary[],
  summary: PostSummary,
  status: PostStatus,
  include: boolean
): PostSummary[] {
  const filtered = current.filter((entry) => entry.frontMatter.id !== summary.frontMatter.id);
  if (!include) return filtered;

  return [...filtered, summary].sort((a, b) => compareSummaries(status, a, b));
}

/**
 * Orders two summaries within a section, by the same rules the main process
 * uses — the comparators live in `@shared/postOrder` because both sides sort
 * the same list and used to disagree on every tie-breaker.
 */
export function compareSummaries(status: PostStatus, a: PostSummary, b: PostSummary): number {
  // A summary's front matter carries id, createdAtUtc and the status times,
  // which is everything an OrderablePost needs.
  return comparatorFor(status)(a.frontMatter as OrderablePost, b.frontMatter as OrderablePost);
}
