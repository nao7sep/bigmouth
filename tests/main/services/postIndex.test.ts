import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import { createPost, updatePost, getPost, listDrafts, changeStatus, clearCache, rebuildIndex } from "@main/core/services/postStore.js";
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

describe("reconcile", () => {
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
