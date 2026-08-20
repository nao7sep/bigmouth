import { describe, it, expect } from "vitest";
import {
  byCreatedDesc,
  byExpiredDesc,
  byPublishedDesc,
  comparatorFor,
  compareInstants,
  type OrderablePost,
} from "@shared/postOrder";

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
// draft/ready comparator with none at all. The renderer re-inserts a mutated
// post on every metadata save and every background content save, so two posts
// sharing a timestamp sat in one order until the next listPosts and a different
// one after it - the list reshuffling under the user with no edit.
describe("post ordering", () => {
  it("breaks a timestamp tie by id, in every bucket", () => {
    const sameInstant = "2026-05-05T00:00:00.000Z";
    const a = post({ id: "aaa", createdAtUtc: sameInstant, publishedAtUtc: sameInstant, expiredAtUtc: sameInstant });
    const b = post({ id: "zzz", createdAtUtc: sameInstant, publishedAtUtc: sameInstant, expiredAtUtc: sameInstant });

    for (const compare of [byCreatedDesc, byPublishedDesc, byExpiredDesc]) {
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

    expect([older, unpublished, newer].sort(byPublishedDesc).map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("picks the comparator from the bucket", () => {
    expect(comparatorFor("published")).toBe(byPublishedDesc);
    expect(comparatorFor("expired")).toBe(byExpiredDesc);
    expect(comparatorFor("draft")).toBe(byCreatedDesc);
    expect(comparatorFor("ready")).toBe(byCreatedDesc);
  });
});
