import { describe, it, expect } from "vitest";
import {
  PAGED_POST_STATUSES,
  POST_STATUSES,
  holdsPublicationTime,
  isPagedPostStatus,
  isPostStatus,
} from "@shared/postStatus";

describe("the post status vocabulary", () => {
  it("is the one enumeration of the five statuses, in the conventions' order", () => {
    expect(POST_STATUSES).toEqual(["draft", "discarded", "verified", "published", "retired"]);
  });

  it("recognizes nothing else — a front-matter field can carry anything", () => {
    expect(isPostStatus("published")).toBe(true);
    expect(isPostStatus("Draft")).toBe(false);
    expect(isPostStatus(undefined)).toBe(false);
  });
});

describe("the paged sections", () => {
  // Discarded behaves like Retired: a section that can grow without bound.
  it("pages discarded, published and retired, and loads draft and verified whole", () => {
    expect(PAGED_POST_STATUSES).toEqual(["discarded", "published", "retired"]);
    expect(POST_STATUSES.filter(isPagedPostStatus)).toEqual(["discarded", "published", "retired"]);
  });
});

describe("holdsPublicationTime", () => {
  it("is true exactly for published and retired, as in the transition table", () => {
    expect(POST_STATUSES.filter(holdsPublicationTime)).toEqual(["published", "retired"]);
  });
});
