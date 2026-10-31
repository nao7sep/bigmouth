import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ContentSaveEvent } from "@main/core/services/postStore.js";
import { createPostStoreFixture } from "./postStore-fixture.js";
let {
  createPost,
  getPost,
  queueContent,
  queueMetadata,
  flushPostEdits,
  flushAllPendingEdits,
  setContentSaveListener,
  updatePost,
  changeStatus,
  setLocked,
  recordAssetChange,
  deletePost,
  rereadPosts,
  listByStatus,
  countByStatus,
  clearCache,
  renameTarget,
} = await import("@main/core/services/postStore.js");

let dataDir: string;
let fixture: Awaited<ReturnType<typeof createPostStoreFixture>>;

beforeEach(async () => {
  fixture = await createPostStoreFixture();
  dataDir = fixture.dataDir;
  ({ createPost, getPost, queueContent, queueMetadata, flushPostEdits, flushAllPendingEdits,
    setContentSaveListener, updatePost, changeStatus, setLocked, recordAssetChange, deletePost,
    rereadPosts, listByStatus, countByStatus, clearCache, renameTarget } = fixture.store);
});

afterEach(() => {
  fixture?.dispose();
});

function publishableDraft(): string {
  // Advancing status requires no slug, so a bare draft is enough.
  const created = createPost(dataDir, "blogger", "en");
  return created.frontMatter.id;
}

describe("authoritative post files", () => {
  it("keeps old-identity edits away from an externally replaced post", () => {
    const post = createPost(dataDir, "blogger", "en");
    const id = post.frontMatter.id;
    queueContent(dataDir, id, "work owned by the original post");
    const replacement = fs.readFileSync(post.filePath, "utf8").replace(id, "replacement-post");
    fs.writeFileSync(post.filePath, replacement);

    expect(getPost(dataDir, id)).toBeNull();
    expect(flushAllPendingEdits()).toEqual([{ id, message: "post file is missing" }]);
    expect(updatePost(dataDir, id, { content: "wrong owner" })).toBeNull();
    expect(changeStatus(dataDir, id, "published")).toBeNull();
    expect(setLocked(dataDir, id, true)).toBeNull();
    expect(fs.readFileSync(post.filePath, "utf8")).toBe(replacement);
  });

  it("reports buffered work as unsaved when the source was locked externally", () => {
    const post = createPost(dataDir, "blogger", "en");
    const id = post.frontMatter.id;
    queueContent(dataDir, id, "still unsaved");
    const locked = fs.readFileSync(post.filePath, "utf8").replace("status: draft", "status: draft\nlocked: true");
    fs.writeFileSync(post.filePath, locked);
    const events: ContentSaveEvent[] = [];
    setContentSaveListener((event) => events.push(event));

    expect(flushAllPendingEdits()).toEqual([{ id, message: "post is locked" }]);
    expect(events.map((event) => event.kind)).toEqual(["locked"]);
    expect(fs.readFileSync(post.filePath, "utf8")).toBe(locked);
    expect(() => updatePost(dataDir, id, { content: "bypass" })).toThrow(/locked/);
    changeStatus(dataDir, id, "published");
    expect(fs.readFileSync(post.filePath, "utf8")).not.toContain("still unsaved");
    setLocked(dataDir, id, false);
    expect(flushPostEdits(dataDir, id)).toBe(true);
    expect(fs.readFileSync(post.filePath, "utf8")).toContain("still unsaved");
  });

  it("selects bulk target changes from the current files, including newly matching files", () => {
    const movedAway = createPost(dataDir, "blogger", "en");
    const movedIn = createPost(dataDir, "other", "en");
    fs.writeFileSync(movedAway.filePath, fs.readFileSync(movedAway.filePath, "utf8").replace("target: blogger", "target: other"));
    fs.writeFileSync(movedIn.filePath, fs.readFileSync(movedIn.filePath, "utf8").replace("target: other", "target: blogger"));
    const added = path.join(dataDir, "posts", "external.md");
    fs.writeFileSync(added, fs.readFileSync(movedIn.filePath, "utf8").replace(movedIn.frontMatter.id, "external-post"));

    expect(renameTarget(dataDir, "blogger", "journal")).toEqual({ updated: 2, skipped: [] });
    expect(fs.readFileSync(movedAway.filePath, "utf8")).toContain("target: other");
    expect(fs.readFileSync(movedIn.filePath, "utf8")).toContain("target: journal");
    expect(fs.readFileSync(added, "utf8")).toContain("target: journal");
  });

  it("leaves an invalid source alone during a bulk target change", () => {
    const post = createPost(dataDir, "blogger", "en");
    const invalid = fs.readFileSync(post.filePath, "utf8").replace("status: draft", "status: unknown");
    fs.writeFileSync(post.filePath, invalid);
    const result = renameTarget(dataDir, "blogger", "journal");
    expect(result.updated).toBe(0);
    expect(result.skipped).toEqual([{ fileName: path.basename(post.filePath), reason: expect.any(String) }]);
    expect(fs.readFileSync(post.filePath, "utf8")).toBe(invalid);
  });

  it("does not report unrelated unreadable files as incomplete source cleanup", () => {
    const post = createPost(dataDir, "blogger", "en");
    const unrelated = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(unrelated.filePath, "---\ntitle: [unclosed\n---\nbody\n");
    expect(deletePost(dataDir, post.frontMatter.id)).toEqual({ cleanupIncomplete: false });
  });

  it.each([
    ["blogger", "zz-copy.md"], ["other", "zz-copy.md"],
    ["blogger", "000-copy.md"], ["other", "000-copy.md"],
  ])("keeps duplicate copies out of bulk writes when the primary target is %s and copy is %s", (target, copyName) => {
    const primary = createPost(dataDir, target, "en");
    const id = primary.frontMatter.id;
    updatePost(dataDir, id, { content: "original text" });
    const copy = path.join(dataDir, "posts", copyName);
    const copyBytes = fs.readFileSync(primary.filePath, "utf8")
      .replace("original text", "copy text")
      .replace("target: other", "target: blogger");
    fs.writeFileSync(copy, copyBytes);
    queueContent(dataDir, id, "pending original text");

    const result = renameTarget(dataDir, "blogger", "journal");
    expect(result.updated).toBe(target === "blogger" ? 1 : 0);
    expect(getPost(dataDir, id)?.filePath).toBe(primary.filePath);
    expect(flushPostEdits(dataDir, id)).toBe(true);
    expect(fs.readFileSync(primary.filePath, "utf8")).toContain("pending original text");
    expect(fs.readFileSync(copy, "utf8")).toBe(copyBytes);
  });

  it.each(["missing", "different identity"])("promotes a surviving copy during a bulk rewrite when the primary is %s", (state) => {
    const primary = createPost(dataDir, "blogger", "en");
    const copy = path.join(dataDir, "posts", "zz-survivor.md");
    fs.copyFileSync(primary.filePath, copy);
    if (state === "missing") fs.unlinkSync(primary.filePath);
    else fs.writeFileSync(primary.filePath, fs.readFileSync(primary.filePath, "utf8")
      .replace(primary.frontMatter.id, "changed-identity")
      .replace("target: blogger", "target: other"));
    expect(renameTarget(dataDir, "blogger", "journal")).toEqual({ updated: 1, skipped: [] });
    expect(getPost(dataDir, primary.frontMatter.id)?.filePath).toBe(copy);
    expect(fs.readFileSync(copy, "utf8")).toContain("target: journal");
  });

  it("does not promote a copy merely because its listed owner cannot be read", () => {
    const primary = createPost(dataDir, "blogger", "en");
    const copy = path.join(dataDir, "posts", "000-copy.md");
    const copyBytes = fs.readFileSync(primary.filePath, "utf8");
    fs.writeFileSync(copy, copyBytes);
    const unreadable = copyBytes.replace("  kind: post\n  version: 1\n", "  kind: post\n  version: 999\n");
    fs.writeFileSync(primary.filePath, unreadable);
    expect(renameTarget(dataDir, "blogger", "journal").updated).toBe(0);
    expect(fs.readFileSync(primary.filePath, "utf8")).toBe(unreadable);
    expect(fs.readFileSync(copy, "utf8")).toBe(copyBytes);
  });
});

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

  it.each([
    ["damaged", "{ not json"],
    ["written by a newer version", JSON.stringify({ format: { owner: "bigmouth", kind: "assetList", version: 999 }, assets: [] })],
  ])("deletes a post whose attachment details are %s, with its attachments", (_case, body) => {
    const post = createPost(dataDir, "blogger", "en");
    const folder = path.join(dataDir, "assets", post.frontMatter.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "a.png"), "abc");
    fs.writeFileSync(path.join(folder, "assets.json"), body);
    expect(deletePost(dataDir, post.frontMatter.id)).toEqual({ cleanupIncomplete: false });
    expect(fs.existsSync(post.filePath)).toBe(false);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("removes the post before clearing links to it, so an interrupted delete never strips a live post's link", () => {
    const source = createPost(dataDir, "blogger", "en");
    const referrer = createPost(dataDir, "blogger", "en", source.frontMatter.id);
    const assets = path.join(dataDir, "assets", source.frontMatter.id);
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "a.png"), "attachment");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    });
    try {
      expect(deletePost(dataDir, source.frontMatter.id)).toEqual({ cleanupIncomplete: true });
    } finally {
      rename.mockRestore();
    }
    expect(fs.existsSync(source.filePath)).toBe(false);
    expect(fs.existsSync(assets)).toBe(false);
    expect(getPost(dataDir, source.frontMatter.id)).toBeNull();
    // The link now names a post that is gone, which the editor lets the user clear.
    expect(getPost(dataDir, referrer.frontMatter.id)?.frontMatter.sourceId).toBe(source.frontMatter.id);
  });

  it("refuses deleting a post a newer version wrote before touching edits or referrers", () => {
    const source = createPost(dataDir, "blogger", "en");
    const referrer = createPost(dataDir, "blogger", "en", source.frontMatter.id);
    queueContent(dataDir, source.frontMatter.id, "keep buffered text");
    const originalPost = fs.readFileSync(source.filePath, "utf8");
    fs.writeFileSync(source.filePath, fs.readFileSync(source.filePath, "utf8").replace("  kind: post\n  version: 1\n", "  kind: post\n  version: 999\n"));
    expect(() => deletePost(dataDir, source.frontMatter.id)).toThrow();
    expect(fs.existsSync(source.filePath)).toBe(true);
    expect(getPost(dataDir, referrer.frontMatter.id)?.frontMatter.sourceId).toBe(source.frontMatter.id);
    // The buffered text survived the refusal and is written once the file is readable again.
    fs.writeFileSync(source.filePath, originalPost);
    expect(flushPostEdits(dataDir, source.frontMatter.id)).toBe(true);
    expect(fs.readFileSync(source.filePath, "utf8")).toContain("keep buffered text");
  });
});

describe("createPost", () => {
  it("creates a draft directly under posts/ and in the list", () => {
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

  it("refuses a slug an external Markdown edit gave another post, once the posts are reread", () => {
    const first = createPost(dataDir, "blogger", "en");
    const second = createPost(dataDir, "blogger", "en");
    const externallyEdited = fs
      .readFileSync(first.filePath, "utf-8")
      .replace("status: draft", "status: draft\nslug: Release-Notes");
    fs.writeFileSync(first.filePath, externallyEdited);
    rereadPosts(dataDir);

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

  it("writes the status times to the file and the list, and drops the ones it clears", () => {
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
    const source = createPost(dataDir, "blogger", "en");
    const post = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, post.frontMatter.id, {
      content: "Body.",
      frontMatter: { title: "Title", sourceId: source.frontMatter.id },
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
    updatePost(dataDir, id, { content: "Body.", frontMatter: { title: "Title", sourceId: getPost(dataDir, id)!.frontMatter.sourceId } });

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
  it("writes the flag to the file and the list, and unlocking removes it", () => {
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
    expect(deletePost(dataDir, id)).toEqual({ cleanupIncomplete: false });
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
  it("reports committed deletion when attachment cleanup fails", () => {
    const post = createPost(dataDir, "blogger", "en");
    const assets = path.join(dataDir, "assets", post.frontMatter.id);
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "kept.png"), "kept");
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("removal refused"); });
    try {
      expect(deletePost(dataDir, post.frontMatter.id)).toEqual({ cleanupIncomplete: true });
    } finally { remove.mockRestore(); }
    expect(fs.existsSync(post.filePath)).toBe(false);
    expect(getPost(dataDir, post.frontMatter.id)).toBeNull();
    expect(fs.existsSync(assets)).toBe(true);
  });

  it("removes the file and its listed post", () => {
    const created = createPost(dataDir, "blogger", "en");
    const id = created.frontMatter.id;

    expect(deletePost(dataDir, id)).toEqual({ cleanupIncomplete: false });
    expect(fs.existsSync(created.filePath)).toBe(false);
    expect(getPost(dataDir, id)).toBeNull();
    expect(ids("draft")).not.toContain(id);
  });

  it("returns null for an unknown id", () => {
    expect(deletePost(dataDir, "nope")).toBeNull();
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
    // The listed post is stale: it still says the broken file links the source.
    fs.writeFileSync(broken.filePath, "---\ntitle: [unclosed\n---\nbody\n");

    expect(deletePost(dataDir, source.frontMatter.id)).toEqual({ cleanupIncomplete: true });

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

describe("reopening a workspace", () => {
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

    // The file disappears but the post stays listed until the posts are reread.
    fs.unlinkSync(gone.filePath);

    // The rename must not throw on the missing file, and must still retarget the
    // surviving post (no all-or-nothing failure leaving some posts behind).
    expect(() => renameTarget(dataDir, "blogger", "journal")).not.toThrow();
    expect(getPost(dataDir, keep.frontMatter.id)?.frontMatter.target).toBe("journal");
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
   * The whole fixture's quit outcome, including any unexpected pending post.
   */
  function quitFailures(...ids: string[]): { id: string; message: string }[] {
    const failures = flushAllPendingEdits();
    expect(failures.every((failure) => ids.includes(failure.id))).toBe(true);
    return failures;
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

  it.runIf(process.platform === "win32")("keeps edits after a read-only post replacement fails and saves them on retry", () => {
    const events: ContentSaveEvent[] = [];
    setContentSaveListener((e) => events.push(e));
    const post = createPost(dataDir, "blogger", "en");
    const before = fs.readFileSync(post.filePath, "utf8");
    queueContent(dataDir, post.frontMatter.id, "held through read-only failure");
    fs.chmodSync(post.filePath, 0o444);
    try {
      expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(false);
      expect(fs.readFileSync(post.filePath, "utf8")).toBe(before);
      expect(events.some((e) => e.kind === "save-failed")).toBe(true);
      expect(events.some((e) => e.kind === "saved")).toBe(false);
      expect(getPost(dataDir, post.frontMatter.id)?.content).toBe("held through read-only failure");
      expect(fs.readdirSync(path.dirname(post.filePath)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally { fs.chmodSync(post.filePath, 0o666); }
    expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(true);
    expect(diskContent(post.filePath)).toContain("held through read-only failure");
    expect(events.at(-1)?.kind).toBe("saved");
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
      rereadPosts(dataDir);
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

    it("keeps and reports content queued for a post that is no longer listed", () => {
      const events: ContentSaveEvent[] = [];
      setContentSaveListener((e) => events.push(e));
      // The list dropped the post before the keystroke arrived (a reread ran
      // first). The queue path must not swallow the text either.
      queueContent(dataDir, "no-such-post", "typed into a post that is gone");
      expect(events).toEqual([{ kind: "post-missing", dataDir, id: "no-such-post" }]);
      expect(quitFailures("no-such-post")).toEqual([
        { id: "no-such-post", message: "post file is missing" },
      ]);
    });
  });
});

describe("a refused post deletion", () => {
  it("retains buffered content and metadata for the next save", () => {
    const post = createPost(dataDir, "blogger", "en");
    queueContent(dataDir, post.frontMatter.id, "draft survives refused delete");
    queueMetadata(dataDir, post.frontMatter.id, { title: "Title survives" });
    const unlink = fs.unlinkSync;
    const refuse = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (file === post.filePath) throw Object.assign(new Error("delete denied"), { code: "EPERM" });
      unlink(file);
    });
    try {
      expect(() => deletePost(dataDir, post.frontMatter.id)).toThrow("delete denied");
      expect(fs.existsSync(post.filePath)).toBe(true);
    } finally { refuse.mockRestore(); }
    expect(flushPostEdits(dataDir, post.frontMatter.id)).toBe(true);
    const saved = getPost(dataDir, post.frontMatter.id)!;
    expect(saved.content).toContain("draft survives refused delete");
    expect(saved.frontMatter.title).toBe("Title survives");
  });
});

describe("one author baseline per pending edit buffer", () => {
  it("reads the post body once across many queued packets and keeps the last semantic edit time", () => {
    const post = createPost(dataDir, "blogger", "en");
    const id = post.frontMatter.id;
    const read = vi.spyOn(fs, "readFileSync");
    const lastEdit = new Date("2030-01-01T00:00:10.000Z");
    try {
      for (let i = 0; i < 10; i++) {
        queueContent(dataDir, id, `Body ${i}`, new Date(lastEdit.getTime() - 1000));
        queueMetadata(dataDir, id, { title: `Title ${i}` }, lastEdit);
      }
      // Canonical-equivalent content and English-only metadata leave the
      // semantic value unchanged, so these later packets cannot move its time.
      queueContent(dataDir, id, "\nBody 9\n\n", new Date(lastEdit.getTime() + 1000));
      queueMetadata(dataDir, id, { title: "Title 9", titleEn: "ignored in English" }, new Date(lastEdit.getTime() + 2000));
      expect(read.mock.calls.filter(([file]) => String(file) === post.filePath)).toHaveLength(1);
    } finally { read.mockRestore(); }
    expect(flushPostEdits(dataDir, id)).toBe(true);
    expect(getPost(dataDir, id)?.frontMatter.updatedAtUtc).toBe(lastEdit.toISOString());

    const nextRead = vi.spyOn(fs, "readFileSync");
    try {
      queueContent(dataDir, id, "Next edit");
      queueMetadata(dataDir, id, { title: "Next title" });
      expect(nextRead.mock.calls.filter(([file]) => String(file) === post.filePath)).toHaveLength(1);
    } finally { nextRead.mockRestore(); }
  });

  it("reads current external fields at flush while keeping the author's buffered fields", () => {
    const post = createPost(dataDir, "blogger", "en");
    const id = post.frontMatter.id;
    queueContent(dataDir, id, "Authored body");
    queueMetadata(dataDir, id, { title: "Authored title" });
    const external = fs.readFileSync(post.filePath, "utf8")
      .replace("target: blogger", "target: externally-changed")
      .replace("status: draft", "status: verified");
    fs.writeFileSync(post.filePath, external);
    queueContent(dataDir, id, "Final authored body");
    expect(flushPostEdits(dataDir, id)).toBe(true);
    const saved = getPost(dataDir, id)!;
    expect(saved.content).toBe("Final authored body");
    expect(saved.frontMatter.title).toBe("Authored title");
    expect(saved.frontMatter.target).toBe("externally-changed");
    expect(saved.frontMatter.status).toBe("verified");
  });

  it("keeps an unreadable baseline as null until the buffer is flushed against a readable file", () => {
    const post = createPost(dataDir, "blogger", "en");
    const id = post.frontMatter.id;
    const original = fs.readFileSync(post.filePath, "utf8");
    fs.writeFileSync(post.filePath, "---\ninvalid: [\n---\n");
    const read = vi.spyOn(fs, "readFileSync");
    try {
      queueContent(dataDir, id, "First");
      queueMetadata(dataDir, id, { title: "Authored title" });
      queueContent(dataDir, id, "Final");
      expect(read.mock.calls.filter(([file]) => String(file) === post.filePath)).toHaveLength(1);
    } finally { read.mockRestore(); }
    fs.writeFileSync(post.filePath, original);
    expect(flushPostEdits(dataDir, id)).toBe(true);
    expect(getPost(dataDir, id)?.content).toBe("Final");
    expect(getPost(dataDir, id)?.frontMatter.title).toBe("Authored title");
  });
});

