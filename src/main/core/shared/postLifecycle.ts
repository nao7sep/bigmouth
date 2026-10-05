/**
 * Moves a post to a new status and sets its status times by the transition
 * table of content-lifecycle-conventions. Retired implies published and
 * published implies verified, so an implied time is set with the move when the
 * source status cannot hold it, and kept when it can.
 */

import type { PostStatus, PostFrontMatter } from "./types.js";
import { formatUtcIso } from "./timestamps.js";
import { compareInstants } from "@shared/postOrder";
import { holdsPublicationTime } from "@shared/postStatus";

export { POST_STATUSES, isPostStatus } from "@shared/postStatus";

/** Every status time a post can hold. */
type StatusTimeKey = "discardedAtUtc" | "verifiedAtUtc" | "publishedAtUtc" | "retiredAtUtc";

/**
 * Mutates `fm` to `newStatus`, setting, keeping and clearing its status times.
 * Selecting the current status changes nothing. Pure with respect to I/O.
 */
export function applyStatusTransition(fm: PostFrontMatter, newStatus: PostStatus, now: Date): void {
  const source = fm.status;
  if (source === newStatus) return;

  const stamp = formatUtcIso(now);
  // Which times the source status holds, so each is kept rather than re-set.
  const holdsVerified = source === "verified" || holdsPublicationTime(source);
  const holdsPublished = holdsPublicationTime(source);

  let discarded: string | undefined;
  let verified: string | undefined;
  let published: string | undefined;
  let retired: string | undefined;
  switch (newStatus) {
    case "discarded":
      discarded = stamp;
      break;
    case "verified":
      verified = keep(holdsVerified, fm.verifiedAtUtc, stamp);
      break;
    case "published":
      verified = keep(holdsVerified, fm.verifiedAtUtc, stamp);
      // Retired → published is an undelete: the original publication time comes back with it.
      published =
        source === "retired"
          ? keep(holdsPublished, fm.publishedAtUtc, notBefore(stamp, verified))
          : notBefore(stamp, verified);
      break;
    case "retired":
      verified = keep(holdsVerified, fm.verifiedAtUtc, stamp);
      published = keep(holdsPublished, fm.publishedAtUtc, notBefore(stamp, verified));
      retired = notBefore(stamp, published);
      break;
    case "draft":
      break;
  }

  setOrClear(fm, "discardedAtUtc", discarded);
  setOrClear(fm, "verifiedAtUtc", verified);
  setOrClear(fm, "publishedAtUtc", published);
  setOrClear(fm, "retiredAtUtc", retired);
  fm.status = newStatus;
}

function keep(holds: boolean, existing: string | undefined, stamp: string): string {
  return holds && existing ? existing : stamp;
}

// A new time never precedes a kept time it follows, even if the clock stepped back.
function notBefore(stamp: string, earlier: string | undefined): string {
  return earlier !== undefined && compareInstants(earlier, stamp) > 0 ? earlier : stamp;
}

function setOrClear(fm: PostFrontMatter, key: StatusTimeKey, value: string | undefined): void {
  if (value === undefined) delete fm[key];
  else fm[key] = value;
}
