import { describe, it, expect } from "vitest";
import { applyStatusTransition, isPostStatus, POST_STATUSES } from "@main/core/shared/postLifecycle.js";
import type { PostFrontMatter, PostStatus } from "@main/core/shared/types.js";

const NOW = new Date("2026-04-05T14:30:22Z");
const STAMP = "2026-04-05T14:30:22.000Z";

// Times a post already holds before a move, each earlier than NOW and in the
// main line's order, so "keep" and "now" can never be confused.
const BEFORE = {
  discardedAtUtc: "2026-02-01T00:00:00.000Z",
  verifiedAtUtc: "2026-02-02T00:00:00.000Z",
  publishedAtUtc: "2026-02-03T00:00:00.000Z",
  retiredAtUtc: "2026-02-04T00:00:00.000Z",
} as const;

type TimeKey = keyof typeof BEFORE;
const TIME_KEYS = Object.keys(BEFORE) as TimeKey[];

// The times each status holds, set as they would be on a post in that status.
const HELD: Record<PostStatus, TimeKey[]> = {
  draft: [],
  discarded: ["discardedAtUtc"],
  verified: ["verifiedAtUtc"],
  published: ["verifiedAtUtc", "publishedAtUtc"],
  retired: ["verifiedAtUtc", "publishedAtUtc", "retiredAtUtc"],
};

function postIn(status: PostStatus): PostFrontMatter {
  const fm: PostFrontMatter = {
    id: "abc123",
    target: "blogger",
    status,
    language: "en",
    createdAtUtc: "2026-01-01T00:00:00.000Z",
    updatedAtUtc: "2026-01-15T00:00:00.000Z",
  };
  for (const key of HELD[status]) fm[key] = BEFORE[key];
  return fm;
}

type Cell = "now" | "keep" | "clear";

// content-lifecycle-conventions' transition table, row for row: the value of
// discarded, verified, published and retired after the move.
const TABLE: [number, PostStatus, PostStatus, [Cell, Cell, Cell, Cell]][] = [
  [1, "draft", "discarded", ["now", "clear", "clear", "clear"]],
  [2, "discarded", "draft", ["clear", "clear", "clear", "clear"]],
  [3, "draft", "verified", ["clear", "now", "clear", "clear"]],
  [4, "verified", "draft", ["clear", "clear", "clear", "clear"]],
  [5, "draft", "published", ["clear", "now", "now", "clear"]],
  [6, "published", "draft", ["clear", "clear", "clear", "clear"]],
  [7, "draft", "retired", ["clear", "now", "now", "now"]],
  [8, "retired", "draft", ["clear", "clear", "clear", "clear"]],
  [9, "discarded", "verified", ["clear", "now", "clear", "clear"]],
  [10, "verified", "discarded", ["now", "clear", "clear", "clear"]],
  [11, "discarded", "published", ["clear", "now", "now", "clear"]],
  [12, "published", "discarded", ["now", "clear", "clear", "clear"]],
  [13, "discarded", "retired", ["clear", "now", "now", "now"]],
  [14, "retired", "discarded", ["now", "clear", "clear", "clear"]],
  [15, "verified", "published", ["clear", "keep", "now", "clear"]],
  [16, "published", "verified", ["clear", "keep", "clear", "clear"]],
  [17, "verified", "retired", ["clear", "keep", "now", "now"]],
  [18, "retired", "verified", ["clear", "keep", "clear", "clear"]],
  [19, "published", "retired", ["clear", "keep", "keep", "now"]],
  [20, "retired", "published", ["clear", "keep", "keep", "clear"]],
];

function expected(cell: Cell, key: TimeKey): string | undefined {
  if (cell === "now") return STAMP;
  if (cell === "keep") return BEFORE[key];
  return undefined;
}

it.each(["discarded", "verified", "published", "retired"] as const)("clamps new %s times to Created after a clock reversal", (status) => {
  const fm = postIn("draft");
  applyStatusTransition(fm, status, new Date("2025-01-01T00:00:00.000Z"));
  for (const key of HELD[status]) expect(fm[key]).toBe(fm.createdAtUtc);
});

describe("POST_STATUSES", () => {
  it("is the five statuses in the conventions' order, and recognizes nothing else", () => {
    expect(POST_STATUSES).toEqual(["draft", "discarded", "verified", "published", "retired"]);
    expect(isPostStatus("retired")).toBe(true);
    // A hand-edited front matter can carry anything at all.
    expect(isPostStatus("Draft")).toBe(false);
    expect(isPostStatus(undefined)).toBe(false);
  });
});

describe("applyStatusTransition", () => {
  it("covers every pair of statuses in both directions", () => {
    const pairs = TABLE.map(([, from, to]) => `${from}>${to}`).sort();
    const all = POST_STATUSES.flatMap((from) =>
      POST_STATUSES.filter((to) => to !== from).map((to) => `${from}>${to}`),
    ).sort();
    expect(pairs).toEqual(all);
  });

  it.each(TABLE)("row %i: %s → %s", (_row, from, to, cells) => {
    const fm = postIn(from);
    applyStatusTransition(fm, to, NOW);

    expect(fm.status).toBe(to);
    TIME_KEYS.forEach((key, i) => {
      expect(fm[key], key).toBe(expected(cells[i], key));
      // A cleared time is gone from the front matter, not left as a key.
      if (cells[i] === "clear") expect(key in fm, key).toBe(false);
    });
  });

  it.each(TABLE)("row %i (%s → %s) leaves created and modified alone", (_row, from, to) => {
    const fm = postIn(from);
    applyStatusTransition(fm, to, NOW);
    expect(fm.createdAtUtc).toBe("2026-01-01T00:00:00.000Z");
    expect(fm.updatedAtUtc).toBe("2026-01-15T00:00:00.000Z");
  });

  it.each(POST_STATUSES.map((status) => [status]))("selecting the current status (%s) changes nothing", (status) => {
    const fm = postIn(status);
    const before = { ...fm };
    applyStatusTransition(fm, status, NOW);
    expect(fm).toEqual(before);
  });

  it("keeps the main line in order after any sequence of moves", () => {
    // Every move from every status, at a later moment each time.
    let moment = Date.parse("2026-03-01T00:00:00.000Z");
    for (const [, from, to] of TABLE) {
      const fm = postIn(from);
      applyStatusTransition(fm, to, new Date((moment += 60_000)));
      const line = [fm.createdAtUtc, fm.verifiedAtUtc, fm.publishedAtUtc, fm.retiredAtUtc].filter(
        (value): value is string => value !== undefined,
      );
      expect([...line].sort(), `${from} → ${to}`).toEqual(line);
      if (fm.status === "discarded") {
        expect([fm.verifiedAtUtc, fm.publishedAtUtc, fm.retiredAtUtc]).toEqual([undefined, undefined, undefined]);
      }
    }
  });

  it("never sets a new time before a kept one when the clock has stepped back", () => {
    // The verification was recorded after the clock that now reads NOW.
    const later = "2026-05-01T00:00:00.000Z";

    const toPublished = postIn("verified");
    toPublished.verifiedAtUtc = later;
    applyStatusTransition(toPublished, "published", NOW);
    expect(toPublished.verifiedAtUtc).toBe(later);
    expect(toPublished.publishedAtUtc).toBe(later);

    const toRetired = postIn("published");
    toRetired.publishedAtUtc = later;
    applyStatusTransition(toRetired, "retired", NOW);
    expect(toRetired.publishedAtUtc).toBe(later);
    expect(toRetired.retiredAtUtc).toBe(later);
  });

  it("takes retired → published as an undelete, bringing back the original publication time", () => {
    const fm = postIn("published");
    applyStatusTransition(fm, "retired", NOW);
    applyStatusTransition(fm, "published", new Date("2026-06-01T00:00:00Z"));
    expect(fm.publishedAtUtc).toBe(BEFORE.publishedAtUtc);
    expect(fm.retiredAtUtc).toBeUndefined();
  });
});
