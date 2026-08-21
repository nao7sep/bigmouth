import { describe, it, expect } from "vitest";
import { POST_STATUSES, isEditLocked, isPostStatus } from "@shared/postStatus";

describe("the post status vocabulary", () => {
  it("is the one enumeration of the four states", () => {
    expect(POST_STATUSES).toEqual(["draft", "ready", "published", "expired"]);
  });

  it("recognizes nothing else — a front-matter field can carry anything", () => {
    expect(isPostStatus("published")).toBe(true);
    expect(isPostStatus("Draft")).toBe(false);
    expect(isPostStatus("archived")).toBe(false);
    expect(isPostStatus(undefined)).toBe(false);
  });
});

describe("the edit lock", () => {
  // Both processes answer from here: main enforces the lock at every write, the
  // renderer decides what to render read-only. The renderer used to re-spell it
  // twice — once as its own helper, once inlined — because the rule lived
  // somewhere it could not import from, under a comment calling itself the
  // single source of truth.
  it("locks exactly published and expired", () => {
    expect(POST_STATUSES.filter(isEditLocked)).toEqual(["published", "expired"]);
  });
});
