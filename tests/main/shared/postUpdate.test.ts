import { describe, it, expect } from "vitest";

import { validatePostUpdate, validateSlug, pickEditableFrontMatter } from "@main/core/shared/postUpdate";

const draft = { id: "p1", status: "draft" as const };

describe("validateSlug", () => {
  it("accepts ascii alphanumerics, hyphens, underscores; rejects others", () => {
    expect(validateSlug("my-post_2")).toBe("my-post_2");
    expect(validateSlug("bad slug")).toBeNull();
    expect(validateSlug("naïve")).toBeNull();
    expect(validateSlug(42)).toBeNull();
  });
});

describe("pickEditableFrontMatter", () => {
  it("copies only editable keys and drops everything else", () => {
    const edits = pickEditableFrontMatter({ title: "T", slug: "s", id: "x", bogus: 1 });
    expect(edits).toEqual({ title: "T", slug: "s" });
  });

  it("returns an empty object for a non-object body", () => {
    expect(pickEditableFrontMatter(null)).toEqual({});
    expect(pickEditableFrontMatter("nope")).toEqual({});
  });
});

describe("validatePostUpdate", () => {
  it("accepts a clean edit, keeping editable keys and dropping unknown ones", () => {
    // `bogus` is neither editable nor reserved, so it is silently dropped.
    const result = validatePostUpdate(draft, { frontMatter: { title: "T", slug: "ok-slug", bogus: 1 } });
    expect(result).toEqual({ ok: true, edits: { title: "T", slug: "ok-slug" } });
  });

  it("accepts an update with no front matter at all", () => {
    expect(validatePostUpdate(draft, {})).toEqual({ ok: true, edits: {} });
  });

  it("rejects edits to a published (locked) post", () => {
    const result = validatePostUpdate({ id: "p1", status: "published" }, { frontMatter: { title: "T" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("published-locked");
      expect(result.message).toMatch(/Published posts are locked/);
    }
  });

  it("rejects edits to an expired (locked) post", () => {
    const result = validatePostUpdate({ id: "p1", status: "expired" }, { frontMatter: { title: "T" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired-locked");
  });

  it("rejects a non-object front matter", () => {
    expect(validatePostUpdate(draft, { frontMatter: [] }).ok).toBe(false);
    const result = validatePostUpdate(draft, { frontMatter: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("front-matter-not-object");
  });

  it("rejects reserved keys and reports which ones", () => {
    const result = validatePostUpdate(draft, { frontMatter: { title: "T", status: "ready", createdAtUtc: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reserved-front-matter");
      expect(result.reservedKeys).toEqual(["status", "createdAtUtc"]);
    }
  });

  it("rejects an invalid slug but allows blank/null (slug cleared)", () => {
    expect(validatePostUpdate(draft, { frontMatter: { slug: "has space" } }).ok).toBe(false);
    expect(validatePostUpdate(draft, { frontMatter: { slug: "" } }).ok).toBe(true);
    expect(validatePostUpdate(draft, { frontMatter: { slug: null } }).ok).toBe(true);
  });

  it("rejects a post that names itself as its source", () => {
    const result = validatePostUpdate(draft, { frontMatter: { sourceId: "p1" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("self-source");
  });

  it("allows a different source id (existence is checked by the handler, not here)", () => {
    expect(validatePostUpdate(draft, { frontMatter: { sourceId: "p2" } })).toEqual({
      ok: true,
      edits: { sourceId: "p2" },
    });
  });
});
