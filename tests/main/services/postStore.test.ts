import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import {
  createPost,
  getPost,
  queueContent,
  queueMetadata,
  flushPostEdits,
  flushAllPendingEdits,
  setContentSaveListener,
  type ContentSaveEvent,
  updatePost,
  changeStatus,
  setLocked,
  recordAssetChange,
  deletePost,
  listByStatus,
  countByStatus,
  clearCache,
  rebuildIndex,
  renameTarget,
  copyPendingEdits,
  holdPendingFlushes,
  resumePendingFlushes,
  announceContentSaveEvents,
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

describe("canonical edit admission and committed writes", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); flushAllPendingEdits(); });

  it("keeps the authored edit time through duplicate and canonical-equivalent packets", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T01:00:00.000Z"));
    const post = createPost(dataDir, "blogger", "en");
    vi.setSystemTime(new Date("2026-10-07T01:01:00.000Z"));
    queueContent(dataDir, post.frontMatter.id, "authored text");
    queueMetadata(dataDir, post.frontMatter.id, { title: "Authored title" });
    vi.setSystemTime(new Date("2026-10-07T01:09:00.000Z"));
    queueContent(dataDir, post.frontMatter.id, "\nauthored text\n\n");
    queueMetadata(dataDir, post.frontMatter.id, { title: "Authored title", titleEn: "stripped for English" });
    expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(true);
    expect(getPost(dataDir, post.frontMatter.id)?.frontMatter.updatedAtUtc).toBe("2026-10-07T01:01:00.000Z");
  });

  it("reports a committed post save when persisting the derived index fails", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "durable body");
    const original = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(dataDir, "posts", "index.json")) throw new Error("derived failure");
      return original(from, to);
    });
    expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(true);
    expect(copyPendingEdits().some((edit) => edit.id === post.frontMatter.id)).toBe(false);
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("durable body");
  });

  it.each(["post", "assets"])("refuses deletion before touching edits or referrers for future %s formats", (kind) => {
    const source = createPost(dataDir, "blogger", "en");
    const referrer = createPost(dataDir, "blogger", "en", source.frontMatter.id);
    queueContent(dataDir, source.frontMatter.id, "keep buffered text");
    const originalPost = fs.readFileSync(source.filePath, "utf8");
    if (kind === "post") {
      fs.writeFileSync(source.filePath, fs.readFileSync(source.filePath, "utf8").replace("formatVersion: 1", "formatVersion: 999"));
    } else {
      const folder = path.join(dataDir, "assets", source.frontMatter.id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ formatVersion: 999, assets: [] }));
    }
    expect(() => deletePost(dataDir, source.frontMatter.id)).toThrow();
    expect(fs.existsSync(source.filePath)).toBe(true);
    expect(copyPendingEdits().some((edit) => edit.id === source.frontMatter.id)).toBe(true);
    expect(getPost(dataDir, referrer.frontMatter.id)?.frontMatter.sourceId).toBe(source.frontMatter.id);
    fs.writeFileSync(source.filePath, originalPost);
    flushPostEdits(dataDir, source.frontMatter.id);
  });
});

describe("createPost", () => {
  it("creates a draft directly under posts/ and in the index", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(post.frontMatter.status).toBe("draft");
    expect(fs.existsSync(post.filePath)).toBe(true);
    expect(path.dirname(post.filePath)).toBe(path.join(dataDir, "posts"));

    const drafts = listByStatus(dataDir, "draft");
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

  it("refuses a slug already used by another post, including a case-only variant", () => {
    const first = createPost(dataDir, "blogger", "en");
    const second = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, first.frontMatter.id, { frontMatter: { slug: "My-Post" } });

    expect(() =>
      updatePost(dataDir, second.frontMatter.id, { frontMatter: { slug: "my-post" } }),
    ).toThrow(/already uses the slug/);
    expect(getPost(dataDir, second.frontMatter.id)?.frontMatter.slug).toBeUndefined();
  });

  it("refuses a slug added to another post by an external Markdown edit", () => {
    const first = createPost(dataDir, "blogger", "en");
    const second = createPost(dataDir, "blogger", "en");
    const externallyEdited = fs
      .readFileSync(first.filePath, "utf-8")
      .replace("status: draft", "status: draft\nslug: Release-Notes");
    fs.writeFileSync(first.filePath, externallyEdited);

    expect(() =>
      updatePost(dataDir, second.frontMatter.id, { frontMatter: { slug: "release-notes" } }),
    ).toThrow(/already uses the slug/);
    expect(getPost(dataDir, second.frontMatter.id)?.frontMatter.slug).toBeUndefined();
  });

  // A slug autosave runs this check on the main process, so it must not read and
  // parse every post body in the workspace.
  it("checks a slug without reading the other posts' files", () => {
    const others = Array.from({ length: 10 }, () => createPost(dataDir, "blogger", "en"));
    const editable = createPost(dataDir, "blogger", "en");
    const read = vi.spyOn(fs, "readFileSync");
    try {
      updatePost(dataDir, editable.frontMatter.id, { frontMatter: { slug: "fresh-slug" } });
      const otherFiles = new Set(others.map((post) => post.filePath));
      expect(read.mock.calls.filter(([file]) => otherFiles.has(String(file)))).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  it("skips an externally edited non-string slug while scanning for conflicts", () => {
    const malformed = createPost(dataDir, "blogger", "en");
    const editable = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(
      malformed.filePath,
      fs
        .readFileSync(malformed.filePath, "utf-8")
        .replace("status: draft", "status: draft\nslug: 123"),
    );

    const updated = updatePost(dataDir, editable.frontMatter.id, {
      frontMatter: { slug: "release-notes" },
    });

    expect(updated?.frontMatter.slug).toBe("release-notes");
    expect(fs.readFileSync(malformed.filePath, "utf-8")).toContain("slug: 123");
  });
});

const ids = (status: Parameters<typeof listByStatus>[1]) =>
  listByStatus(dataDir, status).map((p) => p.frontMatter.id);

// The time rules themselves are pinned row by row in postLifecycle.test.ts;
// these pin that the store applies them and files the post where they say.
describe("changeStatus", () => {
  it("advances draft -> verified without requiring a slug", () => {
    const created = createPost(dataDir, "blogger", "en");
    const verified = changeStatus(dataDir, created.frontMatter.id, "verified");
    expect(verified?.frontMatter.status).toBe("verified");
    expect(verified?.frontMatter.verifiedAtUtc).toBeTruthy();
    expect(verified?.frontMatter.slug).toBeUndefined();
  });

  it("walks every status without moving the file, listing the post under each", () => {
    const id = publishableDraft();
    const filePath = getPost(dataDir, id)!.filePath;

    for (const status of ["discarded", "verified", "published", "retired", "draft"] as const) {
      const moved = changeStatus(dataDir, id, status);
      expect(moved?.frontMatter.status).toBe(status);
      expect(moved?.filePath).toBe(filePath);
      expect(getPost(dataDir, id)?.frontMatter.status).toBe(status);
      expect(ids(status)).toEqual([id]);
      expect(countByStatus(dataDir, status)).toBe(1);
    }
  });

  it("writes the status times to the file and the index, and drops the ones it clears", () => {
    const id = publishableDraft();
    changeStatus(dataDir, id, "retired");
    const retired = getPost(dataDir, id)!;
    expect(retired.frontMatter.verifiedAtUtc).toBeTruthy();
    expect(retired.frontMatter.publishedAtUtc).toBeTruthy();
    expect(retired.frontMatter.retiredAtUtc).toBeTruthy();
    expect(listByStatus(dataDir, "retired")[0].frontMatter).toMatchObject({
      verifiedAtUtc: retired.frontMatter.verifiedAtUtc,
      publishedAtUtc: retired.frontMatter.publishedAtUtc,
      retiredAtUtc: retired.frontMatter.retiredAtUtc,
    });

    changeStatus(dataDir, id, "discarded");
    const disk = fs.readFileSync(retired.filePath, "utf-8");
    expect(disk).toMatch(/discardedAtUtc:/);
    expect(disk).not.toMatch(/verifiedAtUtc|publishedAtUtc|retiredAtUtc/);
  });

  it("brings back the original publication time on retired -> published", () => {
    const id = publishableDraft();
    const publishedAt = changeStatus(dataDir, id, "published")!.frontMatter.publishedAtUtc;
    changeStatus(dataDir, id, "retired");
    expect(changeStatus(dataDir, id, "published")?.frontMatter.publishedAtUtc).toBe(publishedAt);
  });

  it("writes nothing when the status is already the one selected", () => {
    const id = publishableDraft();
    const filePath = getPost(dataDir, id)!.filePath;
    const before = fs.readFileSync(filePath, "utf-8");
    fs.utimesSync(filePath, new Date(0), new Date(0));

    changeStatus(dataDir, id, "draft");

    expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    expect(fs.statSync(filePath).mtimeMs).toBe(0);
  });
});

// content-lifecycle-conventions' Modified: the time moves on every real
// content edit, judged against the file, records when that edit happened, and
// moves on nothing else.
describe("updatedAtUtc", () => {
  const T0 = new Date("2026-03-01T09:00:00.000Z");
  const T1 = new Date("2026-03-02T10:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    setContentSaveListener(null);
    flushAllPendingEdits();
    vi.useRealTimers();
  });

  const modified = (id: string) => getPost(dataDir, id)!.frontMatter.updatedAtUtc;

  function created(): { id: string; filePath: string } {
    const post = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, post.frontMatter.id, {
      content: "Body.",
      frontMatter: { title: "Title", sourceId: "src-1" },
    });
    vi.setSystemTime(T1);
    return { id: post.frontMatter.id, filePath: post.filePath };
  }

  it("starts at the creation time", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(post.frontMatter.updatedAtUtc).toBe(post.frontMatter.createdAtUtc);
  });

  it("records the time of a body edit", () => {
    const { id } = created();
    updatePost(dataDir, id, { content: "Body, edited." });
    expect(modified(id)).toBe(T1.toISOString());
  });

  it("records the time of a metadata edit", () => {
    const { id } = created();
    updatePost(dataDir, id, { frontMatter: { title: "Another title" } });
    expect(modified(id)).toBe(T1.toISOString());
  });

  it("records the time a buffered edit was typed, not the time it is written", () => {
    const { id } = created();
    queueContent(dataDir, id, "Typed.");
    vi.setSystemTime(new Date("2026-03-02T10:00:05.000Z"));
    queueMetadata(dataDir, id, { title: "Retitled" });
    vi.setSystemTime(new Date("2026-03-02T10:05:00.000Z"));
    expect(flushPostEdits(dataDir, id)).toBe(true);
    expect(modified(id)).toBe("2026-03-02T10:00:05.000Z");
  });

  it("records the time of an explicit edit made on top of buffered ones", () => {
    const { id } = created();
    queueContent(dataDir, id, "Typed.");
    const T2 = new Date("2026-03-02T11:00:00.000Z");
    vi.setSystemTime(T2);
    updatePost(dataDir, id, { frontMatter: { title: "Explicit" } });
    expect(modified(id)).toBe(T2.toISOString());
  });

  it("does not move, nor rewrite the file, when the saved content equals the file", () => {
    const { id, filePath } = created();
    const before = fs.readFileSync(filePath, "utf-8");
    fs.utimesSync(filePath, new Date(0), new Date(0));

    // Typed and undone inside the debounce window; the same title; the same
    // source linked again.
    queueContent(dataDir, id, "Body.");
    expect(flushPostEdits(dataDir, id)).toBe(true);
    updatePost(dataDir, id, { content: "Body.", frontMatter: { title: "Title", sourceId: "src-1" } });

    expect(modified(id)).toBe(T0.toISOString());
    expect(fs.readFileSync(filePath, "utf-8")).toBe(before);
    expect(fs.statSync(filePath).mtimeMs).toBe(0);
  });

  it("does not move for a change the save's own cleanup removes", () => {
    const { id } = created();
    updatePost(dataDir, id, { content: "\n\nBody.\n\n\n", frontMatter: { titleEn: "Dropped for English" } });
    expect(modified(id)).toBe(T0.toISOString());
  });

  it("does not move on a status change", () => {
    const { id } = created();
    for (const status of ["discarded", "verified", "published", "retired", "draft"] as const) {
      changeStatus(dataDir, id, status);
      expect(modified(id), status).toBe(T0.toISOString());
    }
  });

  it("moves with a status change only for the buffered edit it writes, to when it was typed", () => {
    const { id } = created();
    queueMetadata(dataDir, id, { title: "Retitled" });
    vi.setSystemTime(new Date("2026-03-05T00:00:00.000Z"));
    changeStatus(dataDir, id, "verified");
    expect(modified(id)).toBe(T1.toISOString());
  });

  it("does not move for buffered edits undone before they are written", () => {
    const { id } = created();
    queueContent(dataDir, id, "Body, briefly.");
    queueContent(dataDir, id, "Body.");
    queueMetadata(dataDir, id, { title: "Title" });
    expect(flushPostEdits(dataDir, id)).toBe(true);
    expect(modified(id)).toBe(T0.toISOString());
  });

  it("does not move on locking or unlocking", () => {
    const { id } = created();
    setLocked(dataDir, id, true);
    expect(modified(id)).toBe(T0.toISOString());
    setLocked(dataDir, id, false);
    expect(modified(id)).toBe(T0.toISOString());
  });

  it("records the time of an asset change", () => {
    const { id } = created();
    recordAssetChange(dataDir, id);
    expect(modified(id)).toBe(T1.toISOString());
  });

  it("does not move when the app rewrites a post on its own", () => {
    const { id } = created();
    const source = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, id, { frontMatter: { sourceId: source.frontMatter.id } });
    vi.setSystemTime(new Date("2026-03-03T11:00:00.000Z"));

    renameTarget(dataDir, "blogger", "blog");
    deletePost(dataDir, source.frontMatter.id);

    const post = getPost(dataDir, id)!;
    expect(post.frontMatter.target).toBe("blog");
    expect(post.frontMatter.sourceId).toBeUndefined();
    expect(post.frontMatter.updatedAtUtc).toBe(T1.toISOString());
  });
});

describe("setLocked", () => {
  it("writes the flag to the file and the index, and unlocking removes it", () => {
    const post = createPost(dataDir, "blogger", "en");
    const id = post.frontMatter.id;

    expect(setLocked(dataDir, id, true)?.frontMatter.locked).toBe(true);
    expect(fs.readFileSync(post.filePath, "utf-8")).toMatch(/^locked: true$/m);
    expect(listByStatus(dataDir, "draft")[0].frontMatter.locked).toBe(true);

    expect(setLocked(dataDir, id, false)?.frontMatter.locked).toBeUndefined();
    expect(fs.readFileSync(post.filePath, "utf-8")).not.toMatch(/locked/);
    expect(listByStatus(dataDir, "draft")[0].frontMatter.locked).toBeUndefined();
  });

  it("changes no status time and no status", () => {
    const id = publishableDraft();
    const published = changeStatus(dataDir, id, "published")!.frontMatter;

    const locked = setLocked(dataDir, id, true)!.frontMatter;
    expect(locked.status).toBe("published");
    expect(locked.verifiedAtUtc).toBe(published.verifiedAtUtc);
    expect(locked.publishedAtUtc).toBe(published.publishedAtUtc);
    expect(locked.updatedAtUtc).toBe(published.updatedAtUtc);
  });

  it("leaves the lifecycle free: a locked post changes status and can be deleted", () => {
    const id = publishableDraft();
    setLocked(dataDir, id, true);

    for (const status of ["discarded", "verified", "published", "retired", "draft"] as const) {
      const moved = changeStatus(dataDir, id, status);
      expect(moved?.frontMatter.status).toBe(status);
      expect(moved?.frontMatter.locked).toBe(true);
    }
    expect(deletePost(dataDir, id)).toBe(true);
    expect(getPost(dataDir, id)).toBeNull();
  });

  it("writes the buffered edits with the lock", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "typed before locking");
    queueMetadata(dataDir, post.frontMatter.id, { title: "Titled before locking" });

    setLocked(dataDir, post.frontMatter.id, true);

    const disk = fs.readFileSync(post.filePath, "utf-8");
    expect(disk).toContain("typed before locking");
    expect(disk).toContain("Titled before locking");
    expect(disk).toMatch(/^locked: true$/m);
    expect(flushAllPendingEdits().filter((failure) => failure.id === post.frontMatter.id)).toEqual([]);
  });

  it("returns null for an unknown post", () => {
    expect(setLocked(dataDir, "nope", true)).toBeNull();
  });
});

describe("deletePost", () => {
  it("removes the file and the index entry", () => {
    const created = createPost(dataDir, "blogger", "en");
    const id = created.frontMatter.id;

    expect(deletePost(dataDir, id)).toBe(true);
    expect(fs.existsSync(created.filePath)).toBe(false);
    expect(getPost(dataDir, id)).toBeNull();
    expect(ids("draft")).not.toContain(id);
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

  it("deletes the source even when a referrer's file cannot be read, and unlinks the rest", () => {
    const source = createPost(dataDir, "blogger", "en");
    const broken = createPost(dataDir, "blogger", "en", source.frontMatter.id);
    const fine = createPost(dataDir, "blogger", "en", source.frontMatter.id);
    // The index row is stale: it still says the broken file links the source.
    fs.writeFileSync(broken.filePath, "---\ntitle: [unclosed\n---\nbody\n");

    expect(deletePost(dataDir, source.frontMatter.id)).toBe(true);

    expect(fs.existsSync(source.filePath)).toBe(false);
    expect(getPost(dataDir, fine.frontMatter.id)?.frontMatter.sourceId).toBeUndefined();
    expect(fs.readFileSync(broken.filePath, "utf-8")).toContain("[unclosed");
  });
});

describe("listByStatus", () => {
  it.each(["discarded", "published", "retired"] as const)("pages %s by offset and limit", (status) => {
    for (let i = 0; i < 3; i++) {
      const created = createPost(dataDir, "blogger", "en");
      changeStatus(dataDir, created.frontMatter.id, status);
    }
    expect(countByStatus(dataDir, status)).toBe(3);
    expect(listByStatus(dataDir, status, { offset: 0, limit: 2 })).toHaveLength(2);
    expect(listByStatus(dataDir, status, { offset: 2, limit: 2 })).toHaveLength(1);
    expect(listByStatus(dataDir, status)).toHaveLength(3);
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
    const result = renameTarget(dataDir, "blogger", "journal");
    expect(result).toEqual({ updated: 2, skipped: [] });
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

  // The index is one file, and every write of it is a full backup row; a rename
  // must not rewrite it once per post.
  it("writes the index once for the whole rename", () => {
    for (let i = 0; i < 5; i += 1) createPost(dataDir, "blogger", "en");
    const indexFile = path.join(dataDir, "posts", "index.json");
    const renames = vi.spyOn(fs, "renameSync");
    try {
      renameTarget(dataDir, "blogger", "journal");
      expect(renames.mock.calls.filter(([, to]) => String(to) === indexFile)).toHaveLength(1);
    } finally {
      renames.mockRestore();
    }
    expect(listByStatus(dataDir, "draft").every((d) => d.frontMatter.target === "journal")).toBe(true);
  });

  it("skips and reports a post file that cannot be read, and renames the rest", () => {
    const broken = createPost(dataDir, "blogger", "en");
    const fine = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(broken.filePath, "---\ntitle: [unclosed\n---\nbody\n");

    const result = renameTarget(dataDir, "blogger", "journal");

    expect(result.updated).toBe(1);
    expect(result.skipped).toEqual([{ fileName: path.basename(broken.filePath), reason: expect.any(String) }]);
    expect(getPost(dataDir, fine.frontMatter.id)?.frontMatter.target).toBe("journal");
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
    flushAllPendingEdits();
  });

  function diskContent(filePath: string): string {
    // Raw file read, bypassing the store: asserts what is durable, not what
    // the overlay reports.
    return fs.readFileSync(filePath, "utf8");
  }

  /**
   * The quit-path failures for the given posts. Text that can never be saved
   * stays buffered by design, so the process-wide buffer can still hold an
   * earlier test's unsaveable post; scoping by id keeps each test honest.
   */
  function quitFailures(...ids: string[]): { id: string; message: string }[] {
    return flushAllPendingEdits().filter((failure) => ids.includes(failure.id));
  }

  it("getPost reads through the buffer while the disk still has the old content", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "typed but not yet flushed");
    expect(getPost(dataDir, post.frontMatter.id)?.content).toBe("typed but not yet flushed");
    expect(diskContent(post.filePath)).not.toContain("typed but not yet flushed");
  });

  it("flushPostEdits writes the buffered content and empties the buffer", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "now durable");
    expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(true);
    expect(diskContent(post.filePath)).toContain("now durable");
    // A second flush has nothing to do and must not rewrite.
    expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(true);
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
    changeStatus(dataDir, post.frontMatter.id, "verified");
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
    expect(flushAllPendingEdits()).toEqual([]);
  });

  // Metadata streams into the same buffer as content, so a field typed the
  // moment before quitting is written by the quit flush.
  it("buffers metadata edits, reads them through, and writes them at quit", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(queueMetadata(dataDir, post.frontMatter.id, { title: "Typed Title", tags: ["a", "b"] })).toBeNull();

    expect(getPost(dataDir, post.frontMatter.id)?.frontMatter.title).toBe("Typed Title");
    expect(diskContent(post.filePath)).not.toContain("Typed Title");

    expect(quitFailures(post.frontMatter.id)).toEqual([]);
    const reread = getPost(dataDir, post.frontMatter.id);
    expect(reread?.frontMatter.title).toBe("Typed Title");
    expect(reread?.frontMatter.tags).toEqual(["a", "b"]);
  });

  it("writes buffered content and metadata together, and a status change carries both", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "body text");
    queueMetadata(dataDir, post.frontMatter.id, { slug: "my-slug" });

    changeStatus(dataDir, post.frontMatter.id, "verified");

    const disk = diskContent(post.filePath);
    expect(disk).toContain("body text");
    expect(disk).toContain("slug: my-slug");
  });

  it("refuses a slug another post holds, on disk or still buffered", () => {
    const first = createPost(dataDir, "blogger", "en");
    const second = createPost(dataDir, "blogger", "en");
    const third = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, first.frontMatter.id, { frontMatter: { slug: "on-disk" } });
    queueMetadata(dataDir, second.frontMatter.id, { slug: "Buffered" });

    expect(queueMetadata(dataDir, third.frontMatter.id, { slug: "ON-DISK" })).toEqual({
      key: "metadata.refusedSlugTaken",
      values: { slug: "ON-DISK" },
    });
    expect(queueMetadata(dataDir, third.frontMatter.id, { slug: "buffered" })).toMatchObject({
      key: "metadata.refusedSlugTaken",
    });
    // A refused edit is not buffered.
    expect(getPost(dataDir, third.frontMatter.id)?.frontMatter.slug).toBeUndefined();
    // A post may keep its own slug.
    expect(queueMetadata(dataDir, second.frontMatter.id, { slug: "buffered" })).toBeNull();
  });

  it("flushAllPendingEdits flushes every buffered post (the quit path)", () => {
    const a = createPost(dataDir, "blogger", "en");
    const b = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, a.frontMatter.id, "post a text");
    queueContent(dataDir, b.frontMatter.id, "post b text");
    expect(quitFailures(a.frontMatter.id, b.frontMatter.id)).toEqual([]);
    expect(diskContent(a.filePath)).toContain("post a text");
    expect(diskContent(b.filePath)).toContain("post b text");
  });

  // The lock boundary, enforced where the write happens. Editing a locked post
  // must be a deliberate act, never an autosave accident — and the renderer's
  // locked editor cannot be that boundary, because it is derived from post
  // state that refreshes only after the lock change has already resolved.
  describe("a locked post is not written by the content stream", () => {
    it("refuses a queued edit and reports it as unsaveable, keeping the text", () => {
      const events: ContentSaveEvent[] = [];
      const post = createPost(dataDir, "blogger", "en");
      setLocked(dataDir, post.frontMatter.id, true);
      const before = diskContent(post.filePath);

      setContentSaveListener((e) => events.push(e));
      queueContent(dataDir, post.frontMatter.id, "TAMPERED VIA THE CONTENT STREAM");

      expect(events).toEqual([{ kind: "locked", dataDir, id: post.frontMatter.id }]);
      expect(diskContent(post.filePath)).toBe(before);
      // The text is the user's work: kept and readable, just never written.
      expect(getPost(dataDir, post.frontMatter.id)?.content).toBe(
        "TAMPERED VIA THE CONTENT STREAM",
      );
    });

    it("refuses at flush time a post that was locked after the edit was queued", () => {
      // The real window: the debounce is long enough for a lock to land
      // between a keystroke and its write, so a queue-time check alone would
      // still rewrite locked content.
      const events: ContentSaveEvent[] = [];
      const post = createPost(dataDir, "blogger", "en");
      queueContent(dataDir, post.frontMatter.id, "typed just before locking");
      setLocked(dataDir, post.frontMatter.id, true);

      // Locking wrote what was buffered first, as it should — that text was
      // typed while the post was still editable. What must not land is what
      // comes after.
      expect(diskContent(post.filePath)).toContain("typed just before locking");
      const locked = diskContent(post.filePath);

      setContentSaveListener((e) => events.push(e));
      queueContent(dataDir, post.frontMatter.id, "typed one keystroke too late");
      expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(false);

      expect(diskContent(post.filePath)).toBe(locked);
      expect(events.map((e) => e.kind)).toEqual(["locked"]);
    });

    it("does not write a locked post's buffered edits with a status change", () => {
      const post = createPost(dataDir, "blogger", "en");
      setLocked(dataDir, post.frontMatter.id, true);
      queueContent(dataDir, post.frontMatter.id, "refused text");

      changeStatus(dataDir, post.frontMatter.id, "published");

      const disk = diskContent(post.filePath);
      expect(disk).toContain("status: published");
      expect(disk).not.toContain("refused text");
    });

    it("reports the locked post at quit rather than writing it", () => {
      const post = createPost(dataDir, "blogger", "en");
      setLocked(dataDir, post.frontMatter.id, true);
      const before = diskContent(post.filePath);
      queueContent(dataDir, post.frontMatter.id, "late night second thoughts");

      expect(quitFailures(post.frontMatter.id)).toEqual([
        { id: post.frontMatter.id, message: "post is locked" },
      ]);
      expect(diskContent(post.filePath)).toBe(before);
    });

    it("saves the kept text once the post is unlocked", () => {
      const post = createPost(dataDir, "blogger", "en");
      setLocked(dataDir, post.frontMatter.id, true);
      queueContent(dataDir, post.frontMatter.id, "kept while locked");
      expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(false);

      setLocked(dataDir, post.frontMatter.id, false);
      expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(true);
      expect(diskContent(post.filePath)).toContain("kept while locked");
    });
  });

  it("notifies saved with the canonical summary after a flush", () => {
    const events: ContentSaveEvent[] = [];
    setContentSaveListener((e) => events.push(e));
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "listened");
    flushPostEdits(dataDir, post.frontMatter.id);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("saved");
    expect(events[0].id).toBe(post.frontMatter.id);
  });

  it.skipIf(process.platform === "win32")("keeps the buffer and notifies save-failed when the write cannot land", () => {
    const events: ContentSaveEvent[] = [];
    setContentSaveListener((e) => events.push(e));
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "held through failure");

    const postsDir = path.dirname(post.filePath);
    fs.chmodSync(postsDir, 0o555);
    try {
      expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(false);
    } finally {
      fs.chmodSync(postsDir, 0o755);
    }
    expect(events.some((e) => e.kind === "save-failed")).toBe(true);
    // The text was never dropped: it is still readable and now flushable.
    expect(getPost(dataDir, post.frontMatter.id)?.content).toBe("held through failure");
    expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(true);
    expect(diskContent(post.filePath)).toContain("held through failure");
  });

  // A post's file can disappear under the app — a workspace may live in a
  // user-chosen external directory, so a sync client, a Finder move or a git
  // checkout is enough. Saving is then impossible, which is exactly why it must
  // never be reported as a save: that is how typed text disappears in silence.
  describe("a post whose file vanished out of band (terminal, not retryable)", () => {
    it("reports the failure and never claims the write landed", () => {
      const events: ContentSaveEvent[] = [];
      setContentSaveListener((e) => events.push(e));
      const post = createPost(dataDir, "blogger", "en");
      const id = post.frontMatter.id;
      queueContent(dataDir, id, "typed after the file was gone");

      fs.unlinkSync(post.filePath);
      expect(flushPostEdits(dataDir, id)).toBe(false);

      expect(events).toContainEqual({ kind: "post-missing", dataDir, id });
      expect(events.some((e) => e.kind === "saved")).toBe(false);
      // Nothing was written: the store does not resurrect a file the user (or
      // their sync client) removed.
      expect(fs.existsSync(post.filePath)).toBe(false);
      // And the quit path still sees unsaved text, so it cannot exit silently.
      expect(quitFailures(id)).toEqual([{ id, message: "post file is missing" }]);
    });

    it("keeps the newest keystrokes buffered instead of discarding them", () => {
      const post = createPost(dataDir, "blogger", "en");
      const id = post.frontMatter.id;
      const onDisk = fs.readFileSync(post.filePath, "utf8");

      queueContent(dataDir, id, "first burst");
      fs.unlinkSync(post.filePath);
      flushPostEdits(dataDir, id);
      // The editor keeps streaming; the newest text must still be taken in.
      queueContent(dataDir, id, "the newest keystrokes");

      // The file comes back (the sync client catches up) — the buffered text is
      // still there to be written, which is only true if it was never dropped.
      fs.writeFileSync(post.filePath, onDisk);
      rebuildIndex(dataDir);
      expect(flushPostEdits(dataDir, id)).toBe(true);
      expect(diskContent(post.filePath)).toContain("the newest keystrokes");
    });

    it("reports once and schedules no retry (a retry could never land)", () => {
      const events: ContentSaveEvent[] = [];
      setContentSaveListener((e) => events.push(e));
      vi.useFakeTimers();
      try {
        const post = createPost(dataDir, "blogger", "en");
        const id = post.frontMatter.id;
        queueContent(dataDir, id, "streamed");
        fs.unlinkSync(post.filePath);

        // The store's own debounce reaches the failure — not just a manual flush.
        vi.advanceTimersByTime(1_000);
        expect(events.filter((e) => e.kind === "post-missing")).toHaveLength(1);
        // Nothing is armed afterwards: a retry loop here would spin forever.
        expect(vi.getTimerCount()).toBe(0);

        // Further keystrokes keep the text without re-reporting or re-arming.
        queueContent(dataDir, id, "streamed more");
        vi.advanceTimersByTime(60_000);
        expect(events.filter((e) => e.kind === "post-missing")).toHaveLength(1);
        expect(events.some((e) => e.kind === "saved" || e.kind === "save-failed")).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps and reports content queued for a post that is no longer indexed", () => {
      const events: ContentSaveEvent[] = [];
      setContentSaveListener((e) => events.push(e));
      // The index dropped the entry before the keystroke arrived (a rebuild ran
      // first). The queue path must not swallow the text either.
      queueContent(dataDir, "no-such-post", "typed into a post that is gone");
      expect(events).toEqual([{ kind: "post-missing", dataDir, id: "no-such-post" }]);
      expect(quitFailures("no-such-post")).toEqual([
        { id: "no-such-post", message: "post file is missing" },
      ]);
    });
  });
});

// At quit the buffer is written on a worker thread of its own (quitFlush.ts):
// the edits are copied across, the copy is written by a fresh store, and this
// thread writes nothing on its own until the quit is over.
describe("the quit's flush on another thread", () => {
  afterEach(() => {
    vi.useRealTimers();
    resumePendingFlushes();
    setContentSaveListener(null);
    flushAllPendingEdits();
  });

  it("writes the copied edits from a fresh store, with the time they were made", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T01:00:00.000Z"));
    const post = createPost(dataDir, "blogger", "en");
    const id = post.frontMatter.id;
    vi.setSystemTime(new Date("2026-10-06T01:05:00.000Z"));
    queueContent(dataDir, id, "typed a moment before quitting");
    expect(queueMetadata(dataDir, id, { title: "Last Title" })).toBeNull();
    const copies = copyPendingEdits().filter((copy) => copy.id === id);

    vi.resetModules();
    const thread = await import("@main/core/services/postStore.js");
    thread.adoptPendingEdits(copies);
    vi.setSystemTime(new Date("2026-10-06T01:09:00.000Z"));
    expect(thread.flushAllPendingEdits()).toEqual([]);

    const written = fs.readFileSync(post.filePath, "utf8");
    expect(written).toContain("typed a moment before quitting");
    expect(written).toContain("Last Title");
    expect(written).toContain("2026-10-06T01:05:00.000Z");

    // This thread kept its copy; writing it again changes nothing on disk.
    expect(flushPostEdits(dataDir, id)).toBe(true);
    expect(fs.readFileSync(post.filePath, "utf8")).toBe(written);
  });

  it("holds the debounce and the retry while a quit owns the buffer, and resumes them after", () => {
    vi.useFakeTimers();
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "armed before the quit");
    holdPendingFlushes();
    queueContent(dataDir, post.frontMatter.id, "typed while the quit runs");
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fs.readFileSync(post.filePath, "utf8")).not.toContain("typed while the quit runs");

    resumePendingFlushes();
    vi.advanceTimersByTime(1_000);
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("typed while the quit runs");
  });

  it("tells this thread's listener what became of edits another thread wrote", () => {
    const events: ContentSaveEvent[] = [];
    setContentSaveListener((event) => events.push(event));
    const missing: ContentSaveEvent = { kind: "post-missing", dataDir, id: "p1" };
    announceContentSaveEvents([missing]);
    expect(events).toEqual([missing]);
  });
});
