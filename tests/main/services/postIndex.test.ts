import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeWorkspaceData } from "@main/core/services/dataDir.js";
import {
  createPost,
  updatePost,
  getPost,
  listByStatus,
  changeStatus,
  setLocked,
  clearCache,
  rebuildIndex,
  deletePost,
  renameTarget,
} from "@main/core/services/postStore.js";
import { NewerFormatError } from "@main/core/shared/storeFormat.js";
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
    expect(json).not.toContain("retiredAtUtc");
    expect(json).not.toContain("locked");
    expect(json).not.toContain("slug");
  });

  it("emits the status times in lifecycle order, then the lock", () => {
    const json = canonicalIndexJson([
      entry({
        id: "a",
        status: "retired",
        discardedAtUtc: "2026-01-01T12:00:00Z",
        verifiedAtUtc: "2026-01-02T00:00:00Z",
        publishedAtUtc: "2026-01-03T00:00:00Z",
        retiredAtUtc: "2026-01-04T00:00:00Z",
        locked: true,
      }),
    ]);
    const order = ["discardedAtUtc", "verifiedAtUtc", "publishedAtUtc", "retiredAtUtc", '"locked": true'].map((key) =>
      json.indexOf(key),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
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

describe("lifecycle projection", () => {
  it("writes retiredAtUtc into the index when a post is retired", () => {
    const created = createPost(dataDir, "blogger", "en");
    changeStatus(dataDir, created.frontMatter.id, "retired");
    expect(indexBytes()).toContain('"status": "retired"');
    expect(indexBytes()).toContain("retiredAtUtc");
  });

  it("writes discardedAtUtc into the index when a post is discarded", () => {
    const created = createPost(dataDir, "blogger", "en");
    changeStatus(dataDir, created.frontMatter.id, "discarded");
    expect(indexBytes()).toContain('"status": "discarded"');
    expect(indexBytes()).toContain("discardedAtUtc");
  });

  it("carries the lock, and a rebuild reads it back from the file", () => {
    const created = createPost(dataDir, "blogger", "en");
    setLocked(dataDir, created.frontMatter.id, true);
    expect(indexBytes()).toContain('"locked": true');

    clearCache(dataDir);
    rebuildIndex(dataDir);
    expect(listByStatus(dataDir, "draft")[0].frontMatter.locked).toBe(true);
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
    const ids = listByStatus(dataDir, "draft").map((p) => p.frontMatter.id);
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
    const drafts = listByStatus(dataDir, "draft").filter((p) => p.frontMatter.id === original.frontMatter.id);
    expect(drafts).toHaveLength(1);
    expect(getPost(dataDir, original.frontMatter.id)).not.toBeNull();

    // Explicit rebuild behaves identically (no throw, still exactly one entry).
    expect(() => rebuildIndex(dataDir)).not.toThrow();
    const afterRebuild = listByStatus(dataDir, "draft").filter((p) => p.frontMatter.id === original.frontMatter.id);
    expect(afterRebuild).toHaveLength(1);
    expect(getPost(dataDir, original.frontMatter.id)).not.toBeNull();
  });
});

// The format marker says which format a file is in, not that every key in it has
// that format's shape: a hand edit can still turn a title into a YAML map, which
// would reach the list as something it cannot show (store-recovery-conventions).
describe("a known front-matter key of the wrong shape", () => {
  it.each([
    ["an object-valued title", "title: Good", "title:\n  nested: map"],
    ["an object-valued target", "target: blogger", "target:\n  name: blogger"],
    ["a tag list holding a map", "status: draft", "status: draft\ntags:\n  - ok\n  - key: value"],
    ["a locked flag that is text", "status: draft", "status: draft\nlocked: \"yes\""],
  ])("leaves %s out of the list and the file as it is, keeping the other posts", (_name, find, replace) => {
    const keeper = createPost(dataDir, "blogger", "en");
    const edited = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, edited.frontMatter.id, { frontMatter: { title: "Good" } });
    const raw = fs.readFileSync(edited.filePath, "utf-8").replace(find, replace);
    expect(raw).toContain(replace);
    fs.writeFileSync(edited.filePath, raw);
    clearCache(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([keeper.frontMatter.id]);
    expect(fs.readFileSync(edited.filePath, "utf-8")).toBe(raw);
    const result = rebuildIndex(dataDir);
    expect(result.skipped).toEqual([
      { fileName: path.basename(edited.filePath), reason: expect.stringMatching(/^\S+\.md: its \w+ is not/) },
    ]);
  });

  it("rebuilds a cached index row of the wrong shape from the post files", () => {
    const post = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, post.frontMatter.id, { frontMatter: { title: "Real title" } });
    const indexFile = path.join(dataDir, "posts", "index.json");
    const stored = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as { formatVersion: number; posts: PostIndexEntry[] };
    (stored.posts[0] as unknown as Record<string, unknown>).title = { nested: "map" };
    fs.writeFileSync(indexFile, JSON.stringify(stored));
    // The index must look newer than the post, so reconcile would trust its rows.
    const later = new Date("2100-01-01T00:00:00.000Z");
    fs.utimesSync(indexFile, later, later);
    clearCache(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.title)).toEqual(["Real title"]);
    expect(JSON.parse(indexBytes()).posts[0].title).toBe("Real title");
  });
});

// A post file may be hand-edited, and its id names the post's asset folder. An
// id of `..` once reached a recursive delete of `assets/..`: the whole
// workspace folder, posts and uploads alike.
describe("a hand-edited post id outside the nanoid grammar", () => {
  function setFileId(filePath: string, id: string): void {
    const raw = fs.readFileSync(filePath, "utf-8");
    fs.writeFileSync(filePath, raw.replace(/^id: .*$/m, `id: ${JSON.stringify(id)}`));
  }

  it.each(["..", ".", "../x"])("never becomes a row, so deleting %s cannot reach outside assets/", (bad) => {
    const keeper = createPost(dataDir, "blogger", "en");
    const edited = createPost(dataDir, "blogger", "en");
    fs.mkdirSync(path.join(dataDir, "assets", keeper.frontMatter.id), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "assets", keeper.frontMatter.id, "a.png"), "x");
    setFileId(edited.filePath, bad);
    clearCache(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([keeper.frontMatter.id]);
    expect(deletePost(dataDir, bad)).toBe(false);
    expect(fs.existsSync(keeper.filePath)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "assets", keeper.frontMatter.id, "a.png"))).toBe(true);

    const result = rebuildIndex(dataDir);
    expect(result.skipped).toEqual([
      { fileName: path.basename(edited.filePath), reason: `invalid post id ${JSON.stringify(bad)}` },
    ]);
  });

  it("is dropped from a hand-edited index.json too", () => {
    const post = createPost(dataDir, "blogger", "en");
    const indexFile = path.join(dataDir, "posts", "index.json");
    const stored = JSON.parse(fs.readFileSync(indexFile, "utf-8")) as { formatVersion: number; posts: PostIndexEntry[] };
    stored.posts.push({ ...stored.posts[0], id: ".." });
    fs.writeFileSync(indexFile, JSON.stringify(stored));
    // The index must look newer than the post, so reconcile trusts its rows.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(indexFile, later, later);
    clearCache(dataDir);

    expect(deletePost(dataDir, "..")).toBe(false);
    expect(fs.existsSync(post.filePath)).toBe(true);
    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([post.frontMatter.id]);
  });
});

// A rebuild is the remedy the app offers for a workspace edited outside it, so
// what it could NOT use is the part the user needs to hear. Reporting only the
// indexed count let a post the user had hand-edited into something unreadable
// disappear from every list under a success message, with the file intact on
// disk and nothing to say so.
describe("a rebuild counts asset folders whose post is gone", () => {
  // deletePost removes a post's assets with it, but a .md deleted outside the
  // app left assets/<id>/ behind with nothing in the UI that could reach it.
  // Nothing here deletes them - they are the user's uploads, and a .md can be
  // restored from git - so the count is the path to them that did not exist.
  it("counts an asset folder left behind by a hand-deleted post", () => {
    const post = createPost(dataDir, "blogger", "en");
    const assets = path.join(dataDir, "assets", post.frontMatter.id);
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "photo.png"), "bytes");

    expect(rebuildIndex(dataDir).orphanedAssets).toBe(0);

    fs.rmSync(post.filePath);
    clearCache(dataDir);

    expect(rebuildIndex(dataDir).orphanedAssets).toBe(1);
    // And the files are still there.
    expect(fs.existsSync(path.join(assets, "photo.png"))).toBe(true);
  });
});

describe("a rebuild says what it left behind", () => {
  function postsPath(name: string): string {
    return path.join(dataDir, "posts", name);
  }

  it("reports nothing skipped for a healthy workspace", () => {
    createPost(dataDir, "blogger", "en");
    createPost(dataDir, "blogger", "en");

    expect(rebuildIndex(dataDir)).toEqual({
      indexed: 2,
      skipped: [],
      duplicateSlugs: [],
      orphanedAssets: 0,
    });
  });

  it("reports duplicate slugs without leaving either post out", () => {
    const first = createPost(dataDir, "blogger", "en");
    const second = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(
      first.filePath,
      fs
        .readFileSync(first.filePath, "utf-8")
        .replace("status: draft", "status: draft\nslug: Release-Notes"),
    );
    fs.writeFileSync(
      second.filePath,
      fs
        .readFileSync(second.filePath, "utf-8")
        .replace("status: draft", "status: draft\nslug: release-notes"),
    );

    const result = rebuildIndex(dataDir);

    expect(result.indexed).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(result.duplicateSlugs).toEqual([
      {
        slug: "release-notes",
        fileNames: [path.basename(first.filePath), path.basename(second.filePath)].sort(),
      },
    ]);
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

  it("reports a non-string slug as an invalid file instead of crashing", () => {
    const post = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(
      post.filePath,
      fs.readFileSync(post.filePath, "utf-8").replace("status: draft", "status: draft\nslug: 123"),
    );

    const result = rebuildIndex(dataDir);

    expect(result.indexed).toBe(0);
    expect(result.skipped).toEqual([
      { fileName: path.basename(post.filePath), reason: `${path.basename(post.filePath)}: its slug is not text` },
    ]);
    expect(fs.readFileSync(post.filePath, "utf-8")).toContain("slug: 123");
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
    expect(listByStatus(dataDir, "published").map((p) => p.frontMatter.id)).toContain(post.frontMatter.id);

    // Edit the file underneath the app, and make it plainly newer than the index.
    const raw = fs.readFileSync(post.filePath, "utf-8").replace("status: published", "status: draft");
    fs.writeFileSync(post.filePath, raw, "utf-8");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(post.filePath, later, later);
    clearCache(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toContain(post.frontMatter.id);
    expect(listByStatus(dataDir, "published").map((p) => p.frontMatter.id)).not.toContain(
      post.frontMatter.id,
    );
  });

  it("leaves an untouched post alone, and does not re-read it", () => {
    const a = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, a.frontMatter.id, { frontMatter: { title: "Kept" } });
    clearCache(dataDir);

    const listed = listByStatus(dataDir, "draft").find((p) => p.frontMatter.id === a.frontMatter.id);
    expect(listed?.frontMatter.title).toBe("Kept");
  });

  it("drops a stale row when its source file becomes invalid", () => {
    const keep = createPost(dataDir, "blogger", "en");
    const broken = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(broken.filePath, "---\nnot: [valid\n---\n\nbody\n", "utf-8");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(broken.filePath, later, later);
    clearCache(dataDir);

    const draftIds = listByStatus(dataDir, "draft").map((post) => post.frontMatter.id);
    expect(draftIds).toContain(keep.frontMatter.id);
    expect(draftIds).not.toContain(broken.frontMatter.id);
    expect(indexBytes()).not.toContain(broken.frontMatter.id);
  });

  it("does not overwrite the original row when an edit creates a duplicate id", () => {
    const original = createPost(dataDir, "blogger", "en");
    const changed = createPost(dataDir, "blogger", "en");
    const raw = fs.readFileSync(changed.filePath, "utf-8").replace(
      changed.frontMatter.id,
      original.frontMatter.id,
    );
    fs.writeFileSync(changed.filePath, raw, "utf-8");
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(changed.filePath, later, later);
    clearCache(dataDir);

    const matching = listByStatus(dataDir, "draft").filter(
      (post) => post.frontMatter.id === original.frontMatter.id,
    );
    expect(matching).toHaveLength(1);
    expect(getPost(dataDir, original.frontMatter.id)?.filePath).toBe(original.filePath);
    expect(indexBytes()).not.toContain(path.basename(changed.filePath));
  });


  it("drops an entry whose file disappeared out of band", () => {
    const keep = createPost(dataDir, "blogger", "en");
    const gone = createPost(dataDir, "blogger", "en");

    clearCache(dataDir);
    fs.unlinkSync(gone.filePath);

    // First access reloads the index and reconciles against disk.
    const draftIds = listByStatus(dataDir, "draft").map((p) => p.frontMatter.id);
    expect(draftIds).toContain(keep.frontMatter.id);
    expect(draftIds).not.toContain(gone.frontMatter.id);
    expect(getPost(dataDir, gone.frontMatter.id)).toBeNull();
    expect(indexBytes()).not.toContain(gone.frontMatter.id);
  });
});

// store-recovery-conventions: each store's format version.
describe("post file format version", () => {
  it("writes this build's format version first in a new post's front matter", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(fs.readFileSync(post.filePath, "utf-8")).toMatch(/^---\nformatVersion: 1\nid: /);
    expect(getPost(dataDir, post.frontMatter.id)?.frontMatter.formatVersion).toBe(1);
  });

  it("skips a post file without its format version as unreadable, leaving it unchanged", () => {
    const post = createPost(dataDir, "blogger", "en");
    const body = fs.readFileSync(post.filePath, "utf-8").replace("formatVersion: 1\n", "");
    fs.writeFileSync(post.filePath, body);
    clearCache(dataDir);

    expect(rebuildIndex(dataDir).skipped).toEqual([
      { fileName: path.basename(post.filePath), reason: expect.stringMatching(/no formatVersion/) },
    ]);
    expect(getPost(dataDir, post.frontMatter.id)).toBeNull();
    expect(fs.readFileSync(post.filePath, "utf-8")).toBe(body);
  });

  it("skips a post file a newer version wrote and leaves it byte-identical", () => {
    const kept = createPost(dataDir, "blogger", "en");
    const newer = createPost(dataDir, "blogger", "en");
    const body = fs.readFileSync(newer.filePath, "utf-8").replace("formatVersion: 1", "formatVersion: 2");
    fs.writeFileSync(newer.filePath, body);

    const rebuilt = rebuildIndex(dataDir);
    expect(rebuilt.skipped.map((s) => s.fileName)).toEqual([path.basename(newer.filePath)]);
    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([kept.frontMatter.id]);
    expect(renameTarget(dataDir, "blogger", "renamed").skipped).toEqual([]);
    expect(fs.readFileSync(newer.filePath, "utf-8")).toBe(body);
  });

  it("refuses to write a post whose file a newer version replaced, leaving it byte-identical", () => {
    const post = createPost(dataDir, "blogger", "en");
    const body = fs.readFileSync(post.filePath, "utf-8").replace("formatVersion: 1", "formatVersion: 2");
    fs.writeFileSync(post.filePath, body);

    expect(() => changeStatus(dataDir, post.frontMatter.id, "verified")).toThrow(NewerFormatError);
    expect(() => setLocked(dataDir, post.frontMatter.id, true)).toThrow(NewerFormatError);
    expect(fs.readFileSync(post.filePath, "utf-8")).toBe(body);
  });
});

describe("post index format version", () => {
  function indexFile(): string {
    return path.join(dataDir, "posts", "index.json");
  }

  it("writes this build's format version and reads the index back", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(indexBytes()).toMatch(/^\{\n {2}"formatVersion": 1,\n {2}"posts": \[/);
    const before = indexBytes();
    clearCache(dataDir);
    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([post.frontMatter.id]);
    expect(indexBytes()).toBe(before);
  });

  it("rebuilds an index without its format version as unreadable", () => {
    const post = createPost(dataDir, "blogger", "en");
    const current = indexBytes();
    const { posts } = JSON.parse(current) as { posts: PostIndexEntry[] };
    fs.writeFileSync(indexFile(), JSON.stringify({ posts }));
    clearCache(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([post.frontMatter.id]);
    expect(indexBytes()).toBe(current);
  });

  it("preserves an externally replaced future index after its cache was warmed", () => {
    const first = createPost(dataDir, "blogger", "en");
    const body = JSON.stringify({ formatVersion: 999, entries: { future: true } });
    fs.writeFileSync(indexFile(), body);
    changeStatus(dataDir, first.frontMatter.id, "verified");
    expect(fs.readFileSync(indexFile(), "utf8")).toBe(body);
    expect(getPost(dataDir, first.frontMatter.id)?.frontMatter.status).toBe("verified");
  });

  it("keeps the index in memory over one a newer version wrote, leaving it byte-identical", () => {
    const first = createPost(dataDir, "blogger", "en");
    const body = JSON.stringify({ formatVersion: 2, entries: { future: true } });
    fs.writeFileSync(indexFile(), body);
    clearCache(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([first.frontMatter.id]);
    const second = createPost(dataDir, "blogger", "en");
    changeStatus(dataDir, first.frontMatter.id, "verified");
    rebuildIndex(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([second.frontMatter.id]);
    expect(fs.readFileSync(indexFile(), "utf-8")).toBe(body);
  });
});
