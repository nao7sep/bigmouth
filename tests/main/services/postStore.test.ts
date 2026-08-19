import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import {
  createPost,
  getPost,
  queueContent,
  flushPostContent,
  flushAllPendingContent,
  setContentSaveListener,
  type ContentSaveEvent,
  updatePost,
  changeStatus,
  deletePost,
  listDrafts,
  listReady,
  listPublished,
  countPublished,
  listExpired,
  countExpired,
  clearCache,
  renameTarget,
} from "@main/core/services/postStore.js";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-poststore-"));
  initializeWorkspaceData(dataDir);
});

afterEach(() => {
  clearCache(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function publishableDraft(): string {
  // A slug is no longer required to advance status, so a bare draft is enough.
  const created = createPost(dataDir, "blogger", "en");
  return created.frontMatter.id;
}

describe("createPost", () => {
  it("creates a draft directly under posts/ and in the index", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(post.frontMatter.status).toBe("draft");
    expect(fs.existsSync(post.filePath)).toBe(true);
    expect(path.dirname(post.filePath)).toBe(path.join(dataDir, "posts"));

    const drafts = listDrafts(dataDir);
    expect(drafts.map((d) => d.frontMatter.id)).toContain(post.frontMatter.id);
  });

  it("names the file {createdAtUtc}-{id}.md", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(path.basename(post.filePath)).toMatch(
      new RegExp(`^\\d{8}-\\d{6}-utc-${post.frontMatter.id}\\.md$`)
    );
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
  it("updates content and metadata while preserving identity and lifecycle", () => {
    const created = createPost(dataDir, "blogger", "en");
    const id = created.frontMatter.id;
    const createdAt = created.frontMatter.createdAtUtc;

    const updated = updatePost(dataDir, id, {
      content: "New body text.",
      frontMatter: { title: "A Title" },
    });

    expect(updated?.content).toBe("New body text.");
    expect(updated?.frontMatter.title).toBe("A Title");
    expect(updated?.frontMatter.id).toBe(id);
    expect(updated?.frontMatter.createdAtUtc).toBe(createdAt);
    expect(updated?.frontMatter.status).toBe("draft");
  });

  it("never moves or renames the file on edit", () => {
    const created = createPost(dataDir, "blogger", "en");
    const updated = updatePost(dataDir, created.frontMatter.id, {
      frontMatter: { title: "A Title", slug: "a-slug" },
    });
    expect(updated?.filePath).toBe(created.filePath);
    expect(fs.existsSync(created.filePath)).toBe(true);
  });

  it("deletes a field when its update value is null", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, { frontMatter: { title: "temp" } });
    const cleared = updatePost(dataDir, created.frontMatter.id, {
      frontMatter: { title: null },
    });
    expect(cleared?.frontMatter.title).toBeUndefined();
  });

  it("drops English supplement fields when language is en", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, {
      frontMatter: { titleEn: "English only supplement" },
    });
    const reread = getPost(dataDir, created.frontMatter.id);
    expect(reread?.frontMatter.titleEn).toBeUndefined();
  });
});

describe("changeStatus", () => {
  it("advances draft -> ready without requiring a slug", () => {
    const created = createPost(dataDir, "blogger", "en");
    const ready = changeStatus(dataDir, created.frontMatter.id, "ready");
    expect(ready?.frontMatter.status).toBe("ready");
    expect(ready?.frontMatter.readyAtUtc).toBeTruthy();
    expect(ready?.frontMatter.slug).toBeUndefined();
  });

  it("advances draft -> ready -> published without moving the file, stamping timestamps", () => {
    const id = publishableDraft();
    const filePath = getPost(dataDir, id)!.filePath;

    const ready = changeStatus(dataDir, id, "ready");
    expect(ready?.frontMatter.status).toBe("ready");
    expect(ready?.frontMatter.readyAtUtc).toBeTruthy();
    expect(ready?.filePath).toBe(filePath);
    expect(listReady(dataDir).map((p) => p.frontMatter.id)).toContain(id);
    expect(listDrafts(dataDir).map((p) => p.frontMatter.id)).not.toContain(id);

    const published = changeStatus(dataDir, id, "published");
    expect(published?.frontMatter.status).toBe("published");
    expect(published?.frontMatter.publishedAtUtc).toBeTruthy();
    expect(published?.filePath).toBe(filePath);
    expect(countPublished(dataDir)).toBe(1);
    expect(listPublished(dataDir, 0, 50).map((p) => p.frontMatter.id)).toContain(id);
  });

  it("clears ready/published timestamps when reverting to draft", () => {
    const id = publishableDraft();
    changeStatus(dataDir, id, "published");

    const reverted = changeStatus(dataDir, id, "draft");
    expect(reverted?.frontMatter.status).toBe("draft");
    expect(reverted?.frontMatter.readyAtUtc).toBeUndefined();
    expect(reverted?.frontMatter.publishedAtUtc).toBeUndefined();
  });

  it("keeps both timestamps when moving published -> ready", () => {
    const id = publishableDraft();
    const published = changeStatus(dataDir, id, "published");
    const publishedAt = published!.frontMatter.publishedAtUtc;
    const readyAt = published!.frontMatter.readyAtUtc;

    const ready = changeStatus(dataDir, id, "ready");
    expect(ready?.frontMatter.status).toBe("ready");
    expect(ready?.frontMatter.publishedAtUtc).toBe(publishedAt);
    expect(ready?.frontMatter.readyAtUtc).toBe(readyAt);
  });

  it("preserves publishedAt across the published -> ready -> published typo round trip", () => {
    const id = publishableDraft();
    const publishedAt = changeStatus(dataDir, id, "published")!.frontMatter.publishedAtUtc;

    changeStatus(dataDir, id, "ready");
    const republished = changeStatus(dataDir, id, "published");
    expect(republished?.frontMatter.publishedAtUtc).toBe(publishedAt);
  });

  it("moves published -> expired, keeping prior timestamps and stamping expiredAt", () => {
    const id = publishableDraft();
    const published = changeStatus(dataDir, id, "published");
    const publishedAt = published!.frontMatter.publishedAtUtc;
    const readyAt = published!.frontMatter.readyAtUtc;

    const expired = changeStatus(dataDir, id, "expired");
    expect(expired?.frontMatter.status).toBe("expired");
    expect(expired?.frontMatter.expiredAtUtc).toBeTruthy();
    expect(expired?.frontMatter.publishedAtUtc).toBe(publishedAt);
    expect(expired?.frontMatter.readyAtUtc).toBe(readyAt);

    expect(countExpired(dataDir)).toBe(1);
    expect(countPublished(dataDir)).toBe(0);
    expect(listExpired(dataDir, 0, 50).map((p) => p.frontMatter.id)).toContain(id);
    expect(listPublished(dataDir, 0, 50).map((p) => p.frontMatter.id)).not.toContain(id);
  });

  it("clears all three timestamps when reverting expired -> draft", () => {
    const id = publishableDraft();
    changeStatus(dataDir, id, "expired");

    const reverted = changeStatus(dataDir, id, "draft");
    expect(reverted?.frontMatter.status).toBe("draft");
    expect(reverted?.frontMatter.readyAtUtc).toBeUndefined();
    expect(reverted?.frontMatter.publishedAtUtc).toBeUndefined();
    expect(reverted?.frontMatter.expiredAtUtc).toBeUndefined();
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

  it("clears sourceId on referrers when the source post is deleted", () => {
    const source = createPost(dataDir, "blogger", "en");
    const child = createPost(dataDir, "blogger", "en", source.frontMatter.id);
    expect(getPost(dataDir, child.frontMatter.id)?.frontMatter.sourceId).toBe(source.frontMatter.id);

    deletePost(dataDir, source.frontMatter.id);

    const reread = getPost(dataDir, child.frontMatter.id);
    expect(reread).not.toBeNull();
    expect(reread?.frontMatter.sourceId).toBeUndefined();
  });
});

describe("listPublished", () => {
  it("paginates by offset and limit", () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = createPost(dataDir, "blogger", "en");
      updatePost(dataDir, created.frontMatter.id, { frontMatter: { slug: `slug-${i}` } });
      changeStatus(dataDir, created.frontMatter.id, "published");
      ids.push(created.frontMatter.id);
    }
    expect(countPublished(dataDir)).toBe(3);
    expect(listPublished(dataDir, 0, 2)).toHaveLength(2);
    expect(listPublished(dataDir, 2, 2)).toHaveLength(1);
  });
});

describe("listExpired", () => {
  it("paginates by offset and limit", () => {
    for (let i = 0; i < 3; i++) {
      const created = createPost(dataDir, "blogger", "en");
      changeStatus(dataDir, created.frontMatter.id, "expired");
    }
    expect(countExpired(dataDir)).toBe(3);
    expect(listExpired(dataDir, 0, 2)).toHaveLength(2);
    expect(listExpired(dataDir, 2, 2)).toHaveLength(1);
  });
});

describe("index recovery", () => {
  it("rediscovers posts from disk after the in-memory cache is cleared", () => {
    const created = createPost(dataDir, "blogger", "en");
    clearCache(dataDir);
    expect(getPost(dataDir, created.frontMatter.id)?.frontMatter.id).toBe(created.frontMatter.id);
  });
});

describe("renameTarget", () => {
  it("retargets every post carrying the old target name", () => {
    const a = createPost(dataDir, "blogger", "en");
    const b = createPost(dataDir, "blogger", "en");
    const count = renameTarget(dataDir, "blogger", "journal");
    expect(count).toBe(2);
    expect(getPost(dataDir, a.frontMatter.id)?.frontMatter.target).toBe("journal");
    expect(getPost(dataDir, b.frontMatter.id)?.frontMatter.target).toBe("journal");
  });

  it("skips an entry whose file vanished out of band instead of throwing partway", () => {
    const keep = createPost(dataDir, "blogger", "en");
    const gone = createPost(dataDir, "blogger", "en");

    // The file disappears but its index entry lingers until the next reconcile.
    fs.unlinkSync(gone.filePath);

    // The rename must not throw on the missing file, and must still retarget the
    // surviving post (no all-or-nothing failure leaving some posts behind).
    expect(() => renameTarget(dataDir, "blogger", "journal")).not.toThrow();
    expect(getPost(dataDir, keep.frontMatter.id)?.frontMatter.target).toBe("journal");
  });
});

// The write-behind buffer is a safety surface: the renderer streams every
// content edit here, and these invariants — readers see the newest text, any
// full write persists it, quit's flushAll leaves nothing behind — are what
// make losing typed text structurally impossible. A wrong answer here is
// silent data loss, so the rules are pinned.
describe("pending content (write-behind buffer)", () => {
  afterEach(() => {
    setContentSaveListener(null);
    flushAllPendingContent();
  });

  function diskContent(filePath: string): string {
    // Raw file read, bypassing the store: asserts what is durable, not what
    // the overlay reports.
    return fs.readFileSync(filePath, "utf8");
  }

  it("getPost reads through the buffer while the disk still has the old content", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "typed but not yet flushed");
    expect(getPost(dataDir, post.frontMatter.id)?.content).toBe("typed but not yet flushed");
    expect(diskContent(post.filePath)).not.toContain("typed but not yet flushed");
  });

  it("flushPostContent writes the buffered content and empties the buffer", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "now durable");
    expect(flushPostContent(dataDir, post.frontMatter.id)).toBe(true);
    expect(diskContent(post.filePath)).toContain("now durable");
    // A second flush has nothing to do and must not rewrite.
    expect(flushPostContent(dataDir, post.frontMatter.id)).toBe(true);
  });

  it("a metadata update persists the buffered content as a side effect", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "carried by the metadata write");
    updatePost(dataDir, post.frontMatter.id, { frontMatter: { title: "T" } });
    expect(diskContent(post.filePath)).toContain("carried by the metadata write");
  });

  it("a status change persists the buffered content as a side effect", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "published text");
    changeStatus(dataDir, post.frontMatter.id, "ready");
    expect(diskContent(post.filePath)).toContain("published text");
  });

  it("an explicit content update supersedes the buffer", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "older keystrokes");
    updatePost(dataDir, post.frontMatter.id, { content: "explicit wins" });
    expect(diskContent(post.filePath)).toContain("explicit wins");
    expect(getPost(dataDir, post.frontMatter.id)?.content).toBe("explicit wins");
  });

  it("deletePost discards the post's buffered content", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "doomed");
    deletePost(dataDir, post.frontMatter.id);
    expect(flushAllPendingContent()).toEqual([]);
  });

  it("content queued for an unknown post is dropped", () => {
    queueContent(dataDir, "no-such-post", "into the void");
    expect(flushAllPendingContent()).toEqual([]);
  });

  it("flushAllPendingContent flushes every buffered post (the quit path)", () => {
    const a = createPost(dataDir, "blogger", "en");
    const b = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, a.frontMatter.id, "post a text");
    queueContent(dataDir, b.frontMatter.id, "post b text");
    expect(flushAllPendingContent()).toEqual([]);
    expect(diskContent(a.filePath)).toContain("post a text");
    expect(diskContent(b.filePath)).toContain("post b text");
  });

  it("notifies saved with the canonical summary after a flush", () => {
    const events: ContentSaveEvent[] = [];
    setContentSaveListener((e) => events.push(e));
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "listened");
    flushPostContent(dataDir, post.frontMatter.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("saved");
    expect(events[0].id).toBe(post.frontMatter.id);
  });

  it("keeps the buffer and notifies save-failed when the write cannot land", () => {
    const events: ContentSaveEvent[] = [];
    setContentSaveListener((e) => events.push(e));
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "held through failure");

    const postsDir = path.dirname(post.filePath);
    fs.chmodSync(postsDir, 0o555);
    try {
      expect(flushPostContent(dataDir, post.frontMatter.id)).toBe(false);
    } finally {
      fs.chmodSync(postsDir, 0o755);
    }
    expect(events.some((e) => e.kind === "save-failed")).toBe(true);
    // The text was never dropped: it is still readable and now flushable.
    expect(getPost(dataDir, post.frontMatter.id)?.content).toBe("held through failure");
    expect(flushPostContent(dataDir, post.frontMatter.id)).toBe(true);
    expect(diskContent(post.filePath)).toContain("held through failure");
  });
});
