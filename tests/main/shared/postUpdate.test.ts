import { describe, it, expect } from "vitest";

import {
  validateMetadataEdit,
  validatePostUpdate,
  validateSlug,
  pickEditableFrontMatter,
} from "@main/core/shared/postUpdate";

const draft = { id: "p1" };

describe("validateSlug", () => {
  it("accepts ascii alphanumerics, hyphens, underscores; rejects others", () => {
    expect(validateSlug("my-post_2")).toBe("my-post_2");
    expect(validateSlug("bad slug")).toBeNull();
    expect(validateSlug("naïve")).toBeNull();
    expect(validateSlug(42)).toBeNull();
  });

  it("requires a visible identity and bounds the export filename", () => {
    expect(validateSlug("-")).toBeNull();
    expect(validateSlug("___")).toBeNull();
    expect(validateSlug("a".repeat(200))).toBe("a".repeat(200));
    expect(validateSlug("a".repeat(201))).toBeNull();
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

  it("rejects edits to a locked post", () => {
    const result = validatePostUpdate({ id: "p1", locked: true }, { frontMatter: { title: "T" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("locked");
      expect(result.message).toMatch(/This post is locked/);
    }
    expect(validateMetadataEdit({ id: "p1", locked: true }, { title: "T" })).toMatchObject({ ok: false, reason: "locked" });
  });

  it("accepts edits to an unlocked post", () => {
    expect(validatePostUpdate({ id: "p1", locked: false }, { frontMatter: { title: "T" } }).ok).toBe(true);
  });

  it("rejects a non-object front matter", () => {
    expect(validatePostUpdate(draft, { frontMatter: [] }).ok).toBe(false);
    const result = validatePostUpdate(draft, { frontMatter: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("front-matter-not-object");
  });

  it("rejects reserved keys and reports which ones", () => {
    const result = validatePostUpdate(draft, { frontMatter: { title: "T", status: "verified", createdAtUtc: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("reserved-front-matter");
      expect(result.reservedKeys).toEqual(["status", "createdAtUtc"]);
    }
  });

  it("reserves every status time and the lock: they move only through their own operations", () => {
    const lifecycle = ["discardedAtUtc", "verifiedAtUtc", "publishedAtUtc", "retiredAtUtc", "updatedAtUtc", "locked"];
    const result = validatePostUpdate(draft, { frontMatter: Object.fromEntries(lifecycle.map((key) => [key, "x"])) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reservedKeys).toEqual(lifecycle);
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
