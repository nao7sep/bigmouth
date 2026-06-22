import type { PostStatus, PostSummary } from "../types";
import { compareInstants } from "./timestamps";

/** The four post-list buckets plus the two paginated-archive totals. */
export interface PostBuckets {
  drafts: PostSummary[];
  checked: PostSummary[];
  published: PostSummary[];
  publishedTotal: number;
  expired: PostSummary[];
  expiredTotal: number;
}

/**
 * Recomputes the four list buckets and the two archive totals after a single
 * post mutation: the post moves into the bucket its new status names and out of
 * wherever it was, and the Published/Expired archive totals are adjusted for a
 * post entering or leaving those buckets.
 *
 * Pure — no refs, no state setters. The caller applies the returned buckets.
 *
 * `openPostStatus` is the status of the currently-open post, but only when that
 * post is the one being mutated AND it is absent from every loaded list (it was
 * reached via a source link, so its previous bucket is off the loaded page);
 * otherwise null. It is the last-resort source for `previousStatus` when the
 * post cannot be located in a loaded list.
 */
export function applyPostMutationToBuckets(
  prev: PostBuckets,
  summary: PostSummary,
  status: PostStatus,
  openPostStatus: PostStatus | null
): PostBuckets {
  const id = summary.frontMatter.id;
  const draftLoaded = prev.drafts.some((entry) => entry.frontMatter.id === id);
  const checkedLoaded = prev.checked.some((entry) => entry.frontMatter.id === id);
  const publishedLoaded = prev.published.some((entry) => entry.frontMatter.id === id);
  const expiredLoaded = prev.expired.some((entry) => entry.frontMatter.id === id);
  const previousStatus: PostStatus | null = draftLoaded
    ? "draft"
    : checkedLoaded
      ? "checked"
      : publishedLoaded
        ? "published"
        : expiredLoaded
          ? "expired"
          : openPostStatus;

  const drafts = nextSummariesForStatus(prev.drafts, summary, "draft", status === "draft");
  const checked = nextSummariesForStatus(prev.checked, summary, "checked", status === "checked");
  // For a paginated archive, only fold the post into the loaded page when it is
  // already there or arriving from elsewhere — a re-save of an archived post not
  // on the current page belongs deeper in the archive, not the top.
  const published = nextSummariesForStatus(
    prev.published,
    summary,
    "published",
    status === "published" && (publishedLoaded || previousStatus !== "published")
  );
  const expired = nextSummariesForStatus(
    prev.expired,
    summary,
    "expired",
    status === "expired" && (expiredLoaded || previousStatus !== "expired")
  );

  let publishedTotal = prev.publishedTotal;
  if (previousStatus === "published" && status !== "published") {
    publishedTotal = Math.max(0, publishedTotal - 1);
  } else if (previousStatus !== null && previousStatus !== "published" && status === "published") {
    publishedTotal += 1;
  }

  let expiredTotal = prev.expiredTotal;
  if (previousStatus === "expired" && status !== "expired") {
    expiredTotal = Math.max(0, expiredTotal - 1);
  } else if (previousStatus !== null && previousStatus !== "expired" && status === "expired") {
    expiredTotal += 1;
  }

  return { drafts, checked, published, publishedTotal, expired, expiredTotal };
}

/**
 * Returns `current` with the mutated post removed, then re-inserted in sorted
 * position when `include` is true (the post belongs in this status' bucket).
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

export function compareSummaries(status: PostStatus, a: PostSummary, b: PostSummary): number {
  if (status === "published") {
    return (
      compareInstants(b.frontMatter.publishedAtUtc ?? "", a.frontMatter.publishedAtUtc ?? "") ||
      (b.frontMatter.slug ?? "").localeCompare(a.frontMatter.slug ?? "")
    );
  }

  if (status === "expired") {
    return (
      compareInstants(b.frontMatter.expiredAtUtc ?? "", a.frontMatter.expiredAtUtc ?? "") ||
      (b.frontMatter.slug ?? "").localeCompare(a.frontMatter.slug ?? "")
    );
  }

  // Drafts and checked posts are ordered newest-created first. The index
  // summaries carry no updatedAtUtc, so creation time is the stable key.
  return compareInstants(b.frontMatter.createdAtUtc ?? "", a.frontMatter.createdAtUtc ?? "");
}
