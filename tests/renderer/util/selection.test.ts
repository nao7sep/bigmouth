import { describe, it, expect } from "vitest";
import { pickAdjacentPostId } from "../../src/../src/util/selection";
import type { PostSummary } from "../../src/types";

function list(...ids: string[]): PostSummary[] {
  return ids.map((id) => ({
    frontMatter: {
      id,
      target: "blogger",
      status: "draft",
      language: "en",
      createdAtUtc: "2026-01-01T00:00:00Z",
    },
  }));
}

describe("pickAdjacentPostId", () => {
  it("picks the next post when one follows", () => {
    expect(pickAdjacentPostId(list("a", "b", "c"), "b")).toBe("c");
  });

  it("picks the previous post when removing the last one", () => {
    expect(pickAdjacentPostId(list("a", "b", "c"), "c")).toBe("b");
  });

  it("picks the next post when removing the first one", () => {
    expect(pickAdjacentPostId(list("a", "b", "c"), "a")).toBe("b");
  });

  it("returns null when removing the only post", () => {
    expect(pickAdjacentPostId(list("a"), "a")).toBeNull();
  });

  it("returns null when the id is not in the list", () => {
    expect(pickAdjacentPostId(list("a", "b"), "z")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickAdjacentPostId(list(), "a")).toBeNull();
  });
});
