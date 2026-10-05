import { describe, it, expect } from "vitest";
import {
  LIST_TIME_KEY,
  byCreatedDesc,
  comparatorFor,
  compareInstants,
  type OrderablePost,
} from "@shared/postOrder";
import { POST_STATUSES } from "@shared/postStatus";

function post(over: Partial<OrderablePost> & { id: string }): OrderablePost {
  return { createdAtUtc: "2026-01-01T00:00:00.000Z", ...over };
}

describe("compareInstants", () => {
  it("orders by the instant, ascending", () => {
    expect(compareInstants("2026-04-05T14:30:22.000Z", "2026-04-05T14:30:23.000Z")).toBeLessThan(0);
    expect(compareInstants("2026-04-05T14:30:23.000Z", "2026-04-05T14:30:22.000Z")).toBeGreaterThan(0);
    expect(compareInstants("2026-04-05T14:30:22.000Z", "2026-04-05T14:30:22.000Z")).toBe(0);
  });

  it("treats different string forms of the same instant as equal (parse-liberal)", () => {
    expect(compareInstants("2026-04-05T14:30:22Z", "2026-04-05T14:30:22.000Z")).toBe(0);
    expect(compareInstants("2026-04-05T14:30:22+00:00", "2026-04-05T14:30:22.000Z")).toBe(0);
  });

  it("orders mixed-precision timestamps chronologically, not lexicographically", () => {
    // Lexicographically "…22.500Z" < "…22Z" ('.' < 'Z'), but chronologically
    // 22.000 < 22.500 — the instant comparator must get this right.
    expect(compareInstants("2026-04-05T14:30:22Z", "2026-04-05T14:30:22.500Z")).toBeLessThan(0);
  });

  it("sorts an absent/unparseable value earliest", () => {
    expect(compareInstants("", "2026-04-05T14:30:22.000Z")).toBeLessThan(0);
    expect(compareInstants("2026-04-05T14:30:22.000Z", "")).toBeGreaterThan(0);
    expect(compareInstants("", "")).toBe(0);
  });
});

// The two processes used to sort the same list with different tie-breakers:
// main on id descending, the renderer on slug descending, and the renderer's
// draft comparator with none at all. The renderer re-inserts a mutated
// post on every metadata save and every background content save, so two posts
// sharing a timestamp sat in one order until the next listPosts and a different
// one after it - the list reshuffling under the user with no edit.
describe("post ordering", () => {
  it("breaks a timestamp tie by id, in every section", () => {
    const sameInstant = "2026-05-05T00:00:00.000Z";
    const times = { createdAtUtc: sameInstant, discardedAtUtc: sameInstant, publishedAtUtc: sameInstant, retiredAtUtc: sameInstant };
    const a = post({ id: "aaa", ...times });
    const b = post({ id: "zzz", ...times });

    for (const compare of POST_STATUSES.map(comparatorFor)) {
      expect([a, b].sort(compare).map((p) => p.id)).toEqual(["zzz", "aaa"]);
      // And the reverse input gives the same answer, which is what "stable
      // between the two processes" actually requires.
      expect([b, a].sort(compare).map((p) => p.id)).toEqual(["zzz", "aaa"]);
    }
  });

  it("orders published by publish time, falling back to creation time", () => {
    const older = post({ id: "a", createdAtUtc: "2026-01-01T00:00:00.000Z", publishedAtUtc: "2026-03-01T00:00:00.000Z" });
    const newer = post({ id: "b", createdAtUtc: "2026-02-01T00:00:00.000Z", publishedAtUtc: "2026-04-01T00:00:00.000Z" });
    const unpublished = post({ id: "c", createdAtUtc: "2026-02-15T00:00:00.000Z" });

    expect([older, unpublished, newer].sort(comparatorFor("published")).map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("orders discarded and retired by their own times, newest first", () => {
    const first = post({ id: "a", discardedAtUtc: "2026-03-01T00:00:00.000Z", retiredAtUtc: "2026-04-01T00:00:00.000Z" });
    const second = post({ id: "b", discardedAtUtc: "2026-03-02T00:00:00.000Z", retiredAtUtc: "2026-03-31T00:00:00.000Z" });

    expect([first, second].sort(comparatorFor("discarded")).map((p) => p.id)).toEqual(["b", "a"]);
    expect([second, first].sort(comparatorFor("retired")).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("gives each section its own time", () => {
    expect(LIST_TIME_KEY).toEqual({
      draft: "createdAtUtc",
      discarded: "discardedAtUtc",
      verified: "createdAtUtc",
      published: "publishedAtUtc",
      retired: "retiredAtUtc",
    });
    expect(comparatorFor("draft")).toBe(byCreatedDesc);
    expect(comparatorFor("verified")).toBe(byCreatedDesc);
  });
});
