import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "./dataDir.js";
import {
  createPost,
  getPost,
  updatePost,
  changeStatus,
  deletePost,
  listDrafts,
  listReady,
  listPublished,
  countPublished,
  clearCache,
} from "./postStore.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-poststore-"));
  initializeWorkspaceData(dataDir);
});

afterEach(() => {
  clearCache(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("createPost", () => {
  it("creates a draft on disk and in the index", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(post.frontMatter.status).toBe("draft");
    expect(fs.existsSync(post.filePath)).toBe(true);
    expect(path.dirname(post.filePath).endsWith(path.join("posts", "drafts"))).toBe(true);

    const drafts = listDrafts(dataDir);
    expect(drafts.map((d) => d.frontMatter.id)).toContain(post.frontMatter.id);
  });

  it("round-trips through getPost by id", () => {
    const created = createPost(dataDir, "blogger", "ja");
    const fetched = getPost(dataDir, created.frontMatter.id);
    expect(fetched?.frontMatter.id).toBe(created.frontMatter.id);
    expect(fetched?.frontMatter.language).toBe("ja");
  });

  it("records a sourceId when supplied", () => {
    const post = createPost(dataDir, "blogger", "en", "src-789");
    expect(post.frontMatter.sourceId).toBe("src-789");
  });

  it("returns null from getPost for an unknown id", () => {
    expect(getPost(dataDir, "does-not-exist")).toBeNull();
  });
});

describe("updatePost", () => {
  it("updates content and metadata while preserving protected fields", () => {
    const created = createPost(dataDir, "blogger", "en");
    const originalId = created.frontMatter.id;
    const originalCreatedAt = created.frontMatter.createdAtUtc;

    const updated = updatePost(dataDir, originalId, {
      content: "New body text.",
      frontMatter: { title: "A Title", status: "published" }, // status must be ignored
    });

    expect(updated?.content).toBe("New body text.");
    expect(updated?.frontMatter.title).toBe("A Title");
    expect(updated?.frontMatter.id).toBe(originalId);
    expect(updated?.frontMatter.createdAtUtc).toBe(originalCreatedAt);
    // Protected: status cannot be changed through updatePost.
    expect(updated?.frontMatter.status).toBe("draft");
  });

  it("deletes a field when its update value is null", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, {
      frontMatter: { title: "temp" },
    });
    const cleared = updatePost(dataDir, created.frontMatter.id, {
      frontMatter: { title: null as unknown as string },
    });
    expect(cleared?.frontMatter.title).toBeUndefined();
  });

  it("drops English supplement fields when language is en", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, {
      frontMatter: { titleEn: "English only supplement" },
    });
    // Re-read from disk: canonicalization must have stripped titleEn.
    const reread = getPost(dataDir, created.frontMatter.id);
    expect(reread?.frontMatter.titleEn).toBeUndefined();
  });
});

describe("changeStatus", () => {
  it("requires a slug to move a draft to ready", () => {
    const created = createPost(dataDir, "blogger", "en");
    expect(() => changeStatus(dataDir, created.frontMatter.id, "ready")).toThrow(
      /slug/i
    );
  });

  it("promotes draft -> ready -> published, moving files and stamping timestamps", () => {
    const created = createPost(dataDir, "blogger", "en");
    const id = created.frontMatter.id;
    updatePost(dataDir, id, { frontMatter: { slug: "my-post" } });

    const ready = changeStatus(dataDir, id, "ready");
    expect(ready?.frontMatter.status).toBe("ready");
    expect(ready?.frontMatter.readyAtUtc).toBeTruthy();
    expect(path.basename(ready!.filePath)).toContain("my-post");
    expect(listReady(dataDir).map((p) => p.frontMatter.id)).toContain(id);
    expect(listDrafts(dataDir).map((p) => p.frontMatter.id)).not.toContain(id);
    // The draft file must no longer exist.
    expect(fs.existsSync(created.filePath)).toBe(false);

    const published = changeStatus(dataDir, id, "published");
    expect(published?.frontMatter.status).toBe("published");
    expect(published?.frontMatter.publishedAtUtc).toBeTruthy();
    expect(countPublished(dataDir)).toBe(1);
    expect(listPublished(dataDir, 0, 50).map((p) => p.frontMatter.id)).toContain(id);
  });

  it("clears ready/published timestamps when reverting to draft", () => {
    const created = createPost(dataDir, "blogger", "en");
    const id = created.frontMatter.id;
    updatePost(dataDir, id, { frontMatter: { slug: "my-post" } });
    changeStatus(dataDir, id, "published");

    const reverted = changeStatus(dataDir, id, "draft");
    expect(reverted?.frontMatter.status).toBe("draft");
    expect(reverted?.frontMatter.readyAtUtc).toBeUndefined();
    expect(reverted?.frontMatter.publishedAtUtc).toBeUndefined();
  });
});

describe("deletePost", () => {
  it("removes the file and the index entry", () => {
    const created = createPost(dataDir, "blogger", "en");
    const id = created.frontMatter.id;

    expect(deletePost(dataDir, id)).toBe(true);
    expect(fs.existsSync(created.filePath)).toBe(false);
    expect(getPost(dataDir, id)).toBeNull();
    expect(listDrafts(dataDir).map((p) => p.frontMatter.id)).not.toContain(id);
  });

  it("returns false for an unknown id", () => {
    expect(deletePost(dataDir, "nope")).toBe(false);
  });
});

describe("cache rebuild", () => {
  it("rediscovers posts from disk after the in-memory cache is cleared", () => {
    const created = createPost(dataDir, "blogger", "en");
    clearCache(dataDir);
    // Forces a fresh index build from the filesystem.
    expect(getPost(dataDir, created.frontMatter.id)?.frontMatter.id).toBe(
      created.frontMatter.id
    );
  });
});
