import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import {
  createPost,
  updatePost,
  getPost,
  listDrafts,
  listPublished,
  changeStatus,
  clearCache,
  rebuildIndex,
} from "@main/core/services/postStore.js";
import { canonicalIndexJson } from "@main/core/services/postIndex.js";
import type { PostIndexEntry } from "@main/core/shared/types.js";

let dataDir: string;

function indexBytes(): string {
  return fs.readFileSync(path.join(dataDir, "posts", "index.json"), "utf-8");
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-postindex-"));
  initializeWorkspaceData(dataDir);
});

afterEach(() => {
  clearCache(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function entry(overrides: Partial<PostIndexEntry>): PostIndexEntry {
  return {
    id: "id",
    fileName: "file.md",
    status: "draft",
    target: "blogger",
    language: "en",
    createdAtUtc: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("canonicalIndexJson", () => {
  it("is independent of input order (sorted by createdAtUtc, then id)", () => {
    const a = entry({ id: "a", createdAtUtc: "2026-01-01T00:00:00Z" });
    const b = entry({ id: "b", createdAtUtc: "2026-02-01T00:00:00Z" });
    const c = entry({ id: "c", createdAtUtc: "2026-02-01T00:00:00Z" });

    const forward = canonicalIndexJson([a, b, c]);
    const shuffled = canonicalIndexJson([c, a, b]);
    expect(shuffled).toBe(forward);

    // c shares b's timestamp, so the id tiebreak must put b before c.
    expect(forward.indexOf('"id": "b"')).toBeLessThan(forward.indexOf('"id": "c"'));
  });

  it("omits absent optional fields and ends with a trailing newline", () => {
    const json = canonicalIndexJson([entry({ id: "a" })]);
    expect(json.endsWith("\n")).toBe(true);
    expect(json).not.toContain("publishedAtUtc");
    expect(json).not.toContain("expiredAtUtc");
    expect(json).not.toContain("slug");
  });

  it("emits expiredAtUtc after publishedAtUtc when present", () => {
    const json = canonicalIndexJson([
      entry({
        id: "a",
        status: "expired",
        readyAtUtc: "2026-01-02T00:00:00Z",
        publishedAtUtc: "2026-01-03T00:00:00Z",
        expiredAtUtc: "2026-01-04T00:00:00Z",
      }),
    ]);
    expect(json).toContain("expiredAtUtc");
    expect(json.indexOf("publishedAtUtc")).toBeLessThan(json.indexOf("expiredAtUtc"));
  });
});

describe("rebuild determinism", () => {
  it("produces byte-identical output from the same files", () => {
    for (let i = 0; i < 3; i++) {
      const created = createPost(dataDir, "blogger", "en");
      updatePost(dataDir, created.frontMatter.id, { frontMatter: { title: `Post ${i}` } });
    }
    const before = indexBytes();
    rebuildIndex(dataDir);
    expect(indexBytes()).toBe(before);
    rebuildIndex(dataDir);
    expect(indexBytes()).toBe(before);
  });
});

describe("write-gating", () => {
  it("leaves the index untouched on a content-only autosave of a titled post", () => {
    const created = createPost(dataDir, "blogger", "en");
    // A title means no body-derived excerpt, so content edits never touch the index.
    updatePost(dataDir, created.frontMatter.id, { frontMatter: { title: "Has a title" } });
    const before = indexBytes();

    updatePost(dataDir, created.frontMatter.id, { content: "A new body that changes only updatedAt." });
    expect(indexBytes()).toBe(before);
  });

  it("rewrites the index when a projected field (title) changes", () => {
    const created = createPost(dataDir, "blogger", "en");
    const before = indexBytes();

    updatePost(dataDir, created.frontMatter.id, { frontMatter: { title: "Now indexed" } });
    expect(indexBytes()).not.toBe(before);
    expect(indexBytes()).toContain("Now indexed");
  });
});

describe("excerpt", () => {
  it("stores a body-derived excerpt for an untitled post", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, { content: "First line of the body.\n\nMore." });
    expect(indexBytes()).toContain('"excerpt"');
    expect(indexBytes()).toContain("First line of the body.");
  });

  it("stores no excerpt once a title is set", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, { content: "Body text here." });
    updatePost(dataDir, created.frontMatter.id, { frontMatter: { title: "A Title" } });
    expect(indexBytes()).not.toContain('"excerpt"');
    expect(indexBytes()).toContain("A Title");
  });

  it("does not churn the index when an edit lands past the excerpt window", () => {
    const created = createPost(dataDir, "blogger", "en");
    const head = "x".repeat(120); // longer than EXCERPT_MAX_CHARS (100)
    updatePost(dataDir, created.frontMatter.id, { content: head });
    const before = indexBytes();
    updatePost(dataDir, created.frontMatter.id, { content: head + " appended tail" });
    expect(indexBytes()).toBe(before);
  });

  it("updates the index when the opening of an untitled post changes", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, { content: "Original opening." });
    const before = indexBytes();
    updatePost(dataDir, created.frontMatter.id, { content: "Rewritten opening." });
    expect(indexBytes()).not.toBe(before);
    expect(indexBytes()).toContain("Rewritten opening.");
  });
});

describe("expired projection", () => {
  it("writes expiredAtUtc into the index when a post is expired", () => {
    const created = createPost(dataDir, "blogger", "en");
    changeStatus(dataDir, created.frontMatter.id, "expired");
    expect(indexBytes()).toContain('"status": "expired"');
    expect(indexBytes()).toContain("expiredAtUtc");
  });
});

describe("tolerates bad source files (one bad file never poisons the workspace)", () => {
  function postsPath(name: string): string {
    return path.join(dataDir, "posts", name);
  }

  it("skips a corrupt or id-less .md file instead of failing the whole load", () => {
    const good = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, good.frontMatter.id, { frontMatter: { title: "Good post" } });

    // A half-written / externally-created file with no front-matter id, plus an
    // empty file, both land in posts/ out of band.
    fs.writeFileSync(postsPath("20260101-000000-utc-bad.md"), "no front matter here\n");
    fs.writeFileSync(postsPath("20260101-000001-utc-empty.md"), "");
    clearCache(dataDir);

    // The good post is still listed and readable; the bad files are skipped.
    const ids = listDrafts(dataDir).map((p) => p.frontMatter.id);
    expect(ids).toContain(good.frontMatter.id);
    expect(getPost(dataDir, good.frontMatter.id)).not.toBeNull();
  });

  it("keeps exactly one entry for a duplicated post id, on both the load and rebuild paths", () => {
    const original = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, original.frontMatter.id, { frontMatter: { title: "Original" } });
    const raw = fs.readFileSync(original.filePath, "utf-8");

    // A copy under a different name carries the same front-matter id.
    fs.writeFileSync(postsPath("20260101-000000-utc-copy.md"), raw);
    clearCache(dataDir);

    // Incremental load: the duplicate is skipped, not silently overwritten away.
    const drafts = listDrafts(dataDir).filter((p) => p.frontMatter.id === original.frontMatter.id);
    expect(drafts).toHaveLength(1);
    expect(getPost(dataDir, original.frontMatter.id)).not.toBeNull();

    // Explicit rebuild behaves identically (no throw, still exactly one entry).
    expect(() => rebuildIndex(dataDir)).not.toThrow();
    const afterRebuild = listDrafts(dataDir).filter((p) => p.frontMatter.id === original.frontMatter.id);
    expect(afterRebuild).toHaveLength(1);
    expect(getPost(dataDir, original.frontMatter.id)).not.toBeNull();
  });
});

// A rebuild is the remedy the app offers for a workspace edited outside it, so
// what it could NOT use is the part the user needs to hear. Reporting only the
// indexed count let a post the user had hand-edited into something unreadable
// disappear from every list under a success message, with the file intact on
// disk and nothing to say so.
describe("a rebuild says what it left behind", () => {
  function postsPath(name: string): string {
    return path.join(dataDir, "posts", name);
  }

  it("reports nothing skipped for a healthy workspace", () => {
    createPost(dataDir, "blogger", "en");
    createPost(dataDir, "blogger", "en");

    expect(rebuildIndex(dataDir)).toEqual({ indexed: 2, skipped: [] });
  });

  it("names a file whose front matter cannot be read", () => {
    const good = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(postsPath("20260101-000000-utc-bad.md"), "---\nnot: [valid\n---\n\nIRREPLACEABLE BODY\n");

    const result = rebuildIndex(dataDir);

    expect(result.indexed).toBe(1);
    expect(result.skipped.map((s) => s.fileName)).toEqual(["20260101-000000-utc-bad.md"]);
    expect(result.skipped[0].reason).toBeTruthy();
    // The good post is unaffected, and the bad file is still on disk.
    expect(getPost(dataDir, good.frontMatter.id)).not.toBeNull();
    expect(fs.readFileSync(postsPath("20260101-000000-utc-bad.md"), "utf-8")).toContain(
      "IRREPLACEABLE BODY",
    );
  });

  it("names a file whose status is not one of the four", () => {
    // Previously copied straight through, so the row existed but matched no
    // bucket: counted as indexed, invisible in the app.
    const good = createPost(dataDir, "blogger", "en");
    const raw = fs.readFileSync(good.filePath, "utf-8").replace("status: draft", "status: Draft");
    fs.writeFileSync(postsPath("20260101-000000-utc-odd.md"), raw.replace(good.frontMatter.id, "other-id"));

    const result = rebuildIndex(dataDir);

    expect(result.indexed).toBe(1);
    expect(result.skipped).toEqual([
      { fileName: "20260101-000000-utc-odd.md", reason: 'unknown status "Draft"' },
    ]);
  });

  it("names the loser of a duplicated post id", () => {
    const original = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(postsPath("20260101-000000-utc-copy.md"), fs.readFileSync(original.filePath, "utf-8"));

    const result = rebuildIndex(dataDir);

    expect(result.indexed).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("duplicate post id");
  });
});

describe("reconcile", () => {
  it("re-reads a post edited out of band, instead of listing its old status", () => {
    // A post's filename is fixed for its lifetime, so a status flipped by a git
    // revert, a merge or a hand edit never changed the name and never triggered
    // a re-projection: the left pane went on listing the post under Published
    // while the editor showed Draft, until the user found Settings → Rebuild.
    const post = createPost(dataDir, "blogger", "en");
    changeStatus(dataDir, post.frontMatter.id, "published");
    expect(listPublished(dataDir, 0, 10).map((p) => p.frontMatter.id)).toContain(post.frontMatter.id);

    // Edit the file underneath the app, and make it plainly newer than the index.
    const raw = fs.readFileSync(post.filePath, "utf-8").replace("status: published", "status: draft");
    fs.writeFileSync(post.filePath, raw, "utf-8");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(post.filePath, later, later);
    clearCache(dataDir);

    expect(listDrafts(dataDir).map((p) => p.frontMatter.id)).toContain(post.frontMatter.id);
    expect(listPublished(dataDir, 0, 10).map((p) => p.frontMatter.id)).not.toContain(
      post.frontMatter.id,
    );
  });

  it("leaves an untouched post alone, and does not re-read it", () => {
    const a = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, a.frontMatter.id, { frontMatter: { title: "Kept" } });
    clearCache(dataDir);

    const listed = listDrafts(dataDir).find((p) => p.frontMatter.id === a.frontMatter.id);
    expect(listed?.frontMatter.title).toBe("Kept");
  });


  it("drops an entry whose file disappeared out of band", () => {
    const keep = createPost(dataDir, "blogger", "en");
    const gone = createPost(dataDir, "blogger", "en");

    clearCache(dataDir);
    fs.unlinkSync(gone.filePath);

    // First access reloads the index and reconciles against disk.
    const draftIds = listDrafts(dataDir).map((p) => p.frontMatter.id);
    expect(draftIds).toContain(keep.frontMatter.id);
    expect(draftIds).not.toContain(gone.frontMatter.id);
    expect(getPost(dataDir, gone.frontMatter.id)).toBeNull();
    expect(indexBytes()).not.toContain(gone.frontMatter.id);
  });
});
