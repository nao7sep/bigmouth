// The post list, read from the post files' front matter when a workspace opens
// and kept current by the app's own writes (data-lifecycle-conventions, Items
// list and sort themselves).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  rereadPosts,
  deletePost,
  renameTarget,
  unreadablePosts,
} from "@main/core/services/postStore.js";
import { NewerFormatError } from "@main/core/shared/storeFormat.js";
import * as logger from "@main/core/services/logger.js";
import { POST_STATUSES } from "@main/core/shared/postLifecycle.js";

let dataDir: string;

/** A post as the list shows it, in whichever section holds it. */
function listed(id: string) {
  return POST_STATUSES.flatMap((status) => listByStatus(dataDir, status)).find((p) => p.frontMatter.id === id)?.frontMatter;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-posts-"));
  initializeWorkspaceData(dataDir);
});

afterEach(() => {
  clearCache(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("excerpt", () => {
  it("lists a body-derived excerpt for an untitled post", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, { content: "First line of the body.\n\nMore." });
    expect(listed(created.frontMatter.id)?.excerpt).toBe("First line of the body. More.");
  });

  it("flags an excerpt cut from a longer body, and only then", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, { content: "Short body." });
    expect(listed(created.frontMatter.id)?.excerptCut).toBeUndefined();
    updatePost(dataDir, created.frontMatter.id, { content: "y".repeat(120) });
    expect(listed(created.frontMatter.id)?.excerptCut).toBe(true);
  });

  it("lists no excerpt once a title is set", () => {
    const created = createPost(dataDir, "blogger", "en");
    updatePost(dataDir, created.frontMatter.id, { content: "Body text here." });
    updatePost(dataDir, created.frontMatter.id, { frontMatter: { title: "A Title" } });
    expect(listed(created.frontMatter.id)).toMatchObject({ title: "A Title" });
    expect(listed(created.frontMatter.id)?.excerpt).toBeUndefined();
  });
});

describe("lifecycle projection", () => {
  it.each([["retired", "retiredAtUtc"], ["discarded", "discardedAtUtc"]] as const)("lists a %s post with its time", (status, key) => {
    const created = createPost(dataDir, "blogger", "en");
    changeStatus(dataDir, created.frontMatter.id, status);
    expect(listed(created.frontMatter.id)).toMatchObject({ status, [key]: expect.any(String) });
  });

  it("carries the lock, and reopening reads it back from the file", () => {
    const created = createPost(dataDir, "blogger", "en");
    setLocked(dataDir, created.frontMatter.id, true);
    expect(listed(created.frontMatter.id)?.locked).toBe(true);

    clearCache(dataDir);
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

  it("keeps exactly one entry for a duplicated post id, on both the open and reread paths", () => {
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

    // An explicit reread behaves identically (no throw, still exactly one entry).
    expect(() => rereadPosts(dataDir)).not.toThrow();
    const afterReread = listByStatus(dataDir, "draft").filter((p) => p.frontMatter.id === original.frontMatter.id);
    expect(afterReread).toHaveLength(1);
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
    const result = rereadPosts(dataDir);
    expect(result.skipped).toEqual([
      { fileName: path.basename(edited.filePath), reason: expect.stringMatching(/^\S+\.md: its \w+ is not/) },
    ]);
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
    expect(deletePost(dataDir, bad)).toBeNull();
    expect(fs.existsSync(keeper.filePath)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "assets", keeper.frontMatter.id, "a.png"))).toBe(true);

    const result = rereadPosts(dataDir);
    expect(result.skipped).toEqual([
      { fileName: path.basename(edited.filePath), reason: `invalid post id ${JSON.stringify(bad)}` },
    ]);
  });

});

// A reread is the remedy the app offers for a workspace edited outside it, so
// what it could NOT use is the part the user needs to hear. Reporting only the
// listed count let a post the user had hand-edited into something unreadable
// disappear from every list under a success message, with the file intact on
// disk and nothing to say so.
describe("a reread counts asset folders whose post is gone", () => {
  // deletePost removes a post's assets with it, but a .md deleted outside the
  // app left assets/<id>/ behind with nothing in the UI that could reach it.
  // Nothing here deletes them - they are the user's uploads, and a .md can be
  // restored from git - so the count is the path to them that did not exist.
  it("counts an asset folder left behind by a hand-deleted post", () => {
    const post = createPost(dataDir, "blogger", "en");
    const assets = path.join(dataDir, "assets", post.frontMatter.id);
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "photo.png"), "bytes");

    expect(rereadPosts(dataDir).orphanedAssets).toBe(0);

    fs.rmSync(post.filePath);
    clearCache(dataDir);

    expect(rereadPosts(dataDir).orphanedAssets).toBe(1);
    // And the files are still there.
    expect(fs.existsSync(path.join(assets, "photo.png"))).toBe(true);
  });
});

describe("a reread says what it left behind", () => {
  function postsPath(name: string): string {
    return path.join(dataDir, "posts", name);
  }

  it("reports nothing skipped for a healthy workspace", () => {
    createPost(dataDir, "blogger", "en");
    createPost(dataDir, "blogger", "en");

    expect(rereadPosts(dataDir)).toEqual({
      listed: 2,
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

    const result = rereadPosts(dataDir);

    expect(result.listed).toBe(2);
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

    const result = rereadPosts(dataDir);

    expect(result.listed).toBe(1);
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
    // bucket: counted as listed, invisible in the app.
    const good = createPost(dataDir, "blogger", "en");
    const raw = fs.readFileSync(good.filePath, "utf-8").replace("status: draft", "status: Draft");
    fs.writeFileSync(postsPath("20260101-000000-utc-odd.md"), raw.replace(good.frontMatter.id, "other-id"));

    const result = rereadPosts(dataDir);

    expect(result.listed).toBe(1);
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

    const result = rereadPosts(dataDir);

    expect(result.listed).toBe(0);
    expect(result.skipped).toEqual([
      { fileName: path.basename(post.filePath), reason: `${path.basename(post.filePath)}: its slug is not text` },
    ]);
    expect(fs.readFileSync(post.filePath, "utf-8")).toContain("slug: 123");
  });

  it("names the loser of a duplicated post id", () => {
    const original = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(postsPath("20260101-000000-utc-copy.md"), fs.readFileSync(original.filePath, "utf-8"));

    const result = rereadPosts(dataDir);

    expect(result.listed).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("duplicate post id");
  });
});

// What the list holds comes from the post files when the workspace opens; the
// app's own writes keep it current, and nothing re-checks the files between.
describe("reading the post files", () => {
  function postsPath(name: string): string {
    return path.join(dataDir, "posts", name);
  }

  it("lists every post of a workspace with no index, each in its section and order", () => {
    const first = createPost(dataDir, "blogger", "en");
    const second = createPost(dataDir, "blogger", "en");
    changeStatus(dataDir, second.frontMatter.id, "published");
    const third = createPost(dataDir, "blogger", "en");
    clearCache(dataDir);

    expect(fs.readdirSync(path.join(dataDir, "posts")).filter((name) => !name.endsWith(".md"))).toEqual([]);
    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([third.frontMatter.id, first.frontMatter.id]);
    expect(listByStatus(dataDir, "published").map((p) => p.frontMatter.id)).toEqual([second.frontMatter.id]);
    expect(unreadablePosts(dataDir)).toEqual([]);
  });

  it("shows a post whose front matter cannot be read as damaged, with its path, and lists the rest", () => {
    const good = createPost(dataDir, "blogger", "en");
    const damaged = postsPath("20260101-000000-utc-damaged.md");
    fs.writeFileSync(damaged, "---\nnot: [valid\n---\n\nbody\n");
    clearCache(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([good.frontMatter.id]);
    expect(unreadablePosts(dataDir)).toEqual([{ path: damaged, newer: false }]);
    expect(fs.readFileSync(damaged, "utf-8")).toContain("body");
  });

  it("deletes the index an earlier build kept, once the posts have been read", () => {
    const post = createPost(dataDir, "blogger", "en");
    const legacy = postsPath("index.json");
    fs.writeFileSync(legacy, JSON.stringify({ formatVersion: 1, posts: [{ id: "stale", fileName: "gone.md", status: "draft" }] }));
    clearCache(dataDir);

    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([post.frontMatter.id]);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("shows an outside edit once the posts are reread or the workspace reopened, not before", () => {
    const post = createPost(dataDir, "blogger", "en");
    changeStatus(dataDir, post.frontMatter.id, "published");
    fs.writeFileSync(post.filePath, fs.readFileSync(post.filePath, "utf-8").replace("status: published", "status: draft"));
    expect(listByStatus(dataDir, "published").map((p) => p.frontMatter.id)).toEqual([post.frontMatter.id]);

    rereadPosts(dataDir);
    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([post.frontMatter.id]);
    expect(listByStatus(dataDir, "published")).toEqual([]);
  });

  it("does not delete a file whose outside edit changed its post identity", () => {
    const post = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(post.filePath, fs.readFileSync(post.filePath, "utf-8").replace(post.frontMatter.id, "new-post-id"));
    expect(deletePost(dataDir, post.frontMatter.id)).toBeNull();
    expect(fs.existsSync(post.filePath)).toBe(true);
  });

  it("refuses to delete shared attachments when another file has the same post id", () => {
    const post = createPost(dataDir, "blogger", "en");
    // Copied after the list was read: deletion checks the files as they are now.
    fs.copyFileSync(post.filePath, postsPath("duplicate.md"));
    const assets = path.join(dataDir, "assets", post.frontMatter.id);
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "photo.png"), "kept");
    expect(() => deletePost(dataDir, post.frontMatter.id)).toThrow();
    expect(fs.existsSync(post.filePath)).toBe(true);
    expect(fs.readFileSync(path.join(assets, "photo.png"), "utf-8")).toBe("kept");
  });

  it("keeps the first file's post when an outside edit gives another file its id", () => {
    const original = createPost(dataDir, "blogger", "en");
    const changed = createPost(dataDir, "blogger", "en");
    fs.writeFileSync(changed.filePath, fs.readFileSync(changed.filePath, "utf-8").replace(changed.frontMatter.id, original.frontMatter.id));
    clearCache(dataDir);

    const matching = listByStatus(dataDir, "draft").filter((post) => post.frontMatter.id === original.frontMatter.id);
    expect(matching).toHaveLength(1);
    const kept = [original.filePath, changed.filePath].sort()[0];
    expect(getPost(dataDir, original.frontMatter.id)?.filePath).toBe(kept);
  });

  it("reports a post whose file disappeared out of band as not found, and drops it", () => {
    const keep = createPost(dataDir, "blogger", "en");
    const gone = createPost(dataDir, "blogger", "en");
    fs.unlinkSync(gone.filePath);

    expect(getPost(dataDir, gone.frontMatter.id)).toBeNull();
    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([keep.frontMatter.id]);
  });
});

// A post file's format version, which tells a build whether it can read the file.
describe("post file format version", () => {
  it("writes this build's format version first in a new post's front matter", () => {
    const post = createPost(dataDir, "blogger", "en");
    expect(fs.readFileSync(post.filePath, "utf-8")).toMatch(/^---\nformatVersion: 1\nid: /);
    expect(getPost(dataDir, post.frontMatter.id)?.frontMatter.formatVersion).toBe(1);
  });

  it("reads a post file without its format version as this build's format", () => {
    const post = createPost(dataDir, "blogger", "en");
    const body = fs.readFileSync(post.filePath, "utf-8").replace("formatVersion: 1\n", "");
    fs.writeFileSync(post.filePath, body);
    clearCache(dataDir);

    expect(rereadPosts(dataDir).skipped).toEqual([]);
    expect(getPost(dataDir, post.frontMatter.id)?.frontMatter.id).toBe(post.frontMatter.id);
  });

  it("skips a post file a newer version wrote and leaves it byte-identical", () => {
    const kept = createPost(dataDir, "blogger", "en");
    const newer = createPost(dataDir, "blogger", "en");
    const body = fs.readFileSync(newer.filePath, "utf-8").replace("formatVersion: 1", "formatVersion: 2");
    fs.writeFileSync(newer.filePath, body);

    const rebuilt = rereadPosts(dataDir);
    expect(rebuilt.skipped.map((s) => s.fileName)).toEqual([path.basename(newer.filePath)]);
    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([kept.frontMatter.id]);
    expect(renameTarget(dataDir, "blogger", "renamed").skipped).toEqual([
      { fileName: path.basename(newer.filePath), reason: expect.any(String) },
    ]);
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

// An interrupted save publishes nothing partial: each file is renamed into place
// whole, and what an interruption leaves behind heals or is ignored.
describe("after an interrupted publication", () => {
  it("ignores a temporary file an interrupted write left beside the posts", () => {
    const post = createPost(dataDir, "blogger", "en");
    const stem = path.basename(post.filePath, ".md");
    fs.writeFileSync(path.join(dataDir, "posts", `${stem}-V1StGXR8_Z5jdHi6B-myT.tmp`), "half a post");
    clearCache(dataDir);
    expect(rereadPosts(dataDir).skipped).toEqual([]);
    expect(listByStatus(dataDir, "draft").map((p) => p.frontMatter.id)).toEqual([post.frontMatter.id]);
  });
});


it("identifies the workspace root in skipped-file and duplicate warnings", () => {
  const otherRoot = path.join(dataDir, "other-workspace");
  initializeWorkspaceData(otherRoot);
  const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
  try {
    for (const root of [dataDir, otherRoot]) {
      fs.writeFileSync(path.join(root, "posts", "bad.md"), "---\nid: [invalid]\n---\nBody");
      for (const [fileName, id] of [["a.md", "same-id"], ["b.md", "same-id"], ["c.md", "other-id"]]) {
        fs.writeFileSync(path.join(root, "posts", fileName), `---\nid: ${id}\nstatus: draft\nslug: shared-slug\n---\nBody`);
      }
      expect(rereadPosts(root)).toMatchObject({ listed: 2 });
    }
    for (const message of ["post file skipped", "post file skipped: duplicate id", "duplicate post slug"]) {
      const events = warnings.mock.calls.filter(([name]) => name === message).map(([, data]) => data);
      expect(events).toEqual([
        expect.objectContaining({ dataDirectory: dataDir }),
        expect.objectContaining({ dataDirectory: otherRoot }),
      ]);
    }
    const duplicateIds = warnings.mock.calls.filter(([name]) => name === "post file skipped: duplicate id");
    for (const [, data] of duplicateIds) expect(data).toMatchObject({ id: "same-id", kept: "a.md", ignored: "b.md" });
  } finally {
    warnings.mockRestore();
    clearCache(otherRoot);
  }
});
