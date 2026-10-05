// Integration test for the post IPC handlers: the real postStore/configStore run
// against a throwaway BIGMOUTH_DATA_DIR + a real registered workspace; only `electron`
// (ipcMain) and the logger are mocked. Each channel's success path is exercised by
// driving the handlers and reading the result back, and each channel's main
// validation / not-found branch is asserted through the thrown Error.
//
// A fresh workspace ships with NO targets (dataDir.ts writes an empty targets.json),
// so a target is registered through the real configStore before any post is created
// — otherwise createPost would always fail with "No targets configured".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHANNELS, type PostContentSavedEvent, type PostUpdate } from "@shared/ipc";
import type { Post, PostListResponse, PostMutationResult, PostStatus, Target } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
// Every main -> renderer send, in order: the far side of the content-save seam.
const sent = vi.hoisted(() => [] as { channel: string; payload: unknown }[]);

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
    ],
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  serializeError: (err: unknown) => ({ message: err instanceof Error ? err.message : String(err) }),
}));

import { initAppDir, createWorkspace } from "@main/core/services/workspaceStore.js";
import { saveTargets } from "@main/core/services/configStore.js";
import { clearCache } from "@main/core/services/postStore.js";
import { registerPostHandlers } from "@main/ipc/posts.js";

let home: string;
let wsId: string;
let dataDir: string;
const SAVED_HOME = process.env.BIGMOUTH_DATA_DIR;

const TARGET: Target = { name: "blogger", defaultLanguage: "en", requiresMetadata: false };

function invoke<T>(channel: string, ...args: unknown[]): T {
  return handlers.get(channel)!({}, ...args) as T;
}

/** Creates a draft through the handler and returns its id. */
function createDraft(target = "blogger", language = "en", sourceId?: string): string {
  const post = invoke<Post>(CHANNELS.createPost, wsId, target, language, sourceId);
  return post.frontMatter.id;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-ipc-posts-"));
  process.env.BIGMOUTH_DATA_DIR = home;
  initAppDir();
  handlers.clear();
  sent.length = 0;
  registerPostHandlers();
  const ws = createWorkspace("WS");
  wsId = ws.id;
  dataDir = ws.dataDirectory;
  // A fresh workspace has no targets; register one so createPost is reachable.
  saveTargets(dataDir, [TARGET]);
});

afterEach(() => {
  clearCache(dataDir);
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_DATA_DIR;
  else process.env.BIGMOUTH_DATA_DIR = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("post IPC handlers — workspace resolution", () => {
  it("rejects an unknown workspace id on any channel", () => {
    expect(() => invoke(CHANNELS.listPosts, "nope", { discarded: 0, published: 0, retired: 0 }, 0)).toThrow(/workspace not found/i);
    expect(() => invoke(CHANNELS.createPost, "nope", "blogger", "en")).toThrow(/workspace not found/i);
  });
});

describe("createPost", () => {
  it("creates a draft and returns its front matter + content", () => {
    const post = invoke<Post>(CHANNELS.createPost, wsId, "blogger", "en");
    expect(post.frontMatter.status).toBe("draft");
    expect(post.frontMatter.target).toBe("blogger");
    expect(post.frontMatter.language).toBe("en");
    expect(post.frontMatter.id).toBeTruthy();
    expect(typeof post.content).toBe("string");
  });

  it("trims target/language and records a sourceId that exists", () => {
    const source = createDraft();
    const post = invoke<Post>(CHANNELS.createPost, wsId, "  blogger  ", "  en  ", `  ${source}  `);
    expect(post.frontMatter.target).toBe("blogger");
    expect(post.frontMatter.sourceId).toBe(source);
  });

  it("requires target and language", () => {
    expect(() => invoke(CHANNELS.createPost, wsId, "", "en")).toThrow(/target and language are required/);
    expect(() => invoke(CHANNELS.createPost, wsId, "blogger", "   ")).toThrow(/target and language are required/);
  });

  it("rejects a non-string sourceId", () => {
    expect(() => invoke(CHANNELS.createPost, wsId, "blogger", "en", 123 as unknown as string)).toThrow(
      /sourceId must be a string/,
    );
  });

  it("rejects an unknown target", () => {
    expect(() => invoke(CHANNELS.createPost, wsId, "ghost", "en")).toThrow(/Unknown target: ghost/);
  });

  it("rejects an unsupported language", () => {
    expect(() => invoke(CHANNELS.createPost, wsId, "blogger", "xx")).toThrow(/Unsupported language: xx/);
  });

  it("rejects a sourceId that does not exist", () => {
    expect(() => invoke(CHANNELS.createPost, wsId, "blogger", "en", "missing-id")).toThrow(/Source post not found/);
  });

  it("rejects creation when no targets are configured", () => {
    saveTargets(dataDir, []);
    expect(() => invoke(CHANNELS.createPost, wsId, "blogger", "en")).toThrow(/No targets configured/);
  });
});

describe("getPost", () => {
  it("returns a created post by id", () => {
    const id = createDraft();
    const post = invoke<Post>(CHANNELS.getPost, wsId, id);
    expect(post.frontMatter.id).toBe(id);
    expect(post).toHaveProperty("content");
  });

  it("throws 'Post not found' for an unknown id", () => {
    expect(() => invoke(CHANNELS.getPost, wsId, "does-not-exist")).toThrow(/Post not found/);
  });
});

const FIRST_PAGES = { discarded: 0, published: 0, retired: 0 };

const listIds = (res: PostListResponse, status: PostStatus) => res[status].posts.map((d) => d.frontMatter.id);

describe("listPosts", () => {
  it("returns a section for every status, with totals and offsets", () => {
    const byStatus = {} as Record<PostStatus, string>;
    for (const status of ["draft", "discarded", "verified", "published", "retired"] as const) {
      byStatus[status] = createDraft();
      if (status !== "draft") invoke(CHANNELS.changePostStatus, wsId, byStatus[status], status);
    }

    const res = invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0);
    for (const status of ["draft", "discarded", "verified", "published", "retired"] as const) {
      expect(listIds(res, status), status).toEqual([byStatus[status]]);
      expect(res[status].total, status).toBe(1);
      expect(res[status].offset, status).toBe(0);
    }
  });

  it("clamps negative offsets to 0 and falls back to the settings limit when limit is 0", () => {
    const res = invoke<PostListResponse>(CHANNELS.listPosts, wsId, { discarded: -1, published: -5, retired: -3 }, 0);
    expect(res.discarded.offset).toBe(0);
    expect(res.published.offset).toBe(0);
    expect(res.retired.offset).toBe(0);
  });

  it.each(["discarded", "published", "retired"] as const)("pages %s posts by its own offset and the limit", (status) => {
    for (let i = 0; i < 3; i++) {
      invoke(CHANNELS.changePostStatus, wsId, createDraft(), status);
    }
    const firstPage = invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 2);
    expect(firstPage[status].posts).toHaveLength(2);
    expect(firstPage[status].total).toBe(3);
    const secondPage = invoke<PostListResponse>(CHANNELS.listPosts, wsId, { ...FIRST_PAGES, [status]: 2 }, 2);
    expect(secondPage[status].posts).toHaveLength(1);
    expect(secondPage[status].offset).toBe(2);
  });

  it("loads draft and verified posts whole, whatever the limit", () => {
    for (let i = 0; i < 3; i++) createDraft();
    expect(invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 1).draft.posts).toHaveLength(3);
  });
});

// Post files are the user's to edit outside the app (git, another editor), and
// nothing watches them: every list read reconciles the index with them first.
describe("listPosts after an edit on disk", () => {
  function postFile(id: string): string {
    const dir = path.join(dataDir, "posts");
    const name = fs.readdirSync(dir).find((file) => fs.readFileSync(path.join(dir, file), "utf8").includes(id));
    return path.join(dir, name!);
  }

  it("shows a status and title changed in the file since the last read", () => {
    const id = createDraft();
    expect(listIds(invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0), "draft")).toContain(id);

    const file = postFile(id);
    const edited = fs.readFileSync(file, "utf8").replace("status: draft", "status: verified").replace(/^---\n/, "---\ntitle: Edited in git\n");
    fs.writeFileSync(file, edited);
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(file, later, later);

    const res = invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0);
    expect(listIds(res, "draft")).not.toContain(id);
    expect(res.verified.posts.find((d) => d.frontMatter.id === id)?.frontMatter.title).toBe("Edited in git");
  });

  it("drops a post whose file was removed since the last read", () => {
    const id = createDraft();
    invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0);
    fs.rmSync(postFile(id));
    expect(listIds(invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0), "draft")).not.toContain(id);
  });
});

describe("updatePost", () => {
  it("updates content + editable front matter and returns a summary", () => {
    const id = createDraft();
    const result = invoke<PostMutationResult>(CHANNELS.updatePost, wsId, id, {
      content: "New body.",
      frontMatter: { title: "A Title", slug: "a-slug" },
    });
    expect(result.content).toBe("New body.");
    expect(result.frontMatter.title).toBe("A Title");
    expect(result.frontMatter.slug).toBe("a-slug");
    expect(result.summary?.id).toBe(id);

    // Read back through getPost to confirm it persisted, not just echoed.
    const reread = invoke<Post>(CHANNELS.getPost, wsId, id);
    expect(reread.content).toBe("New body.");
    expect(reread.frontMatter.title).toBe("A Title");
  });

  it("ignores unknown front matter keys (cannot invent front matter)", () => {
    const id = createDraft();
    const result = invoke<PostMutationResult>(CHANNELS.updatePost, wsId, id, {
      frontMatter: { bogus: "nope" } as unknown as PostUpdate["frontMatter"],
    });
    expect(result.frontMatter).not.toHaveProperty("bogus");
  });

  it("throws 'Post not found' for an unknown id", () => {
    expect(() => invoke(CHANNELS.updatePost, wsId, "missing", { content: "x" })).toThrow(/Post not found/);
  });

  it("rejects a non-object front matter", () => {
    const id = createDraft();
    expect(() =>
      invoke(CHANNELS.updatePost, wsId, id, { frontMatter: [] as unknown as PostUpdate["frontMatter"] }),
    ).toThrow(/frontMatter must be an object/);
  });

  it("rejects reserved front matter keys", () => {
    const id = createDraft();
    expect(() =>
      invoke(CHANNELS.updatePost, wsId, id, {
        frontMatter: { status: "published" } as unknown as PostUpdate["frontMatter"],
      }),
    ).toThrow(/Reserved front matter fields cannot be updated/);
  });

  it("rejects an invalid slug", () => {
    const id = createDraft();
    expect(() =>
      invoke(CHANNELS.updatePost, wsId, id, {
        frontMatter: { slug: "not a slug!" },
      }),
    ).toThrow(/Invalid slug/);
  });

  it("rejects a self-referential sourceId", () => {
    const id = createDraft();
    expect(() =>
      invoke(CHANNELS.updatePost, wsId, id, { frontMatter: { sourceId: id } }),
    ).toThrow(/A post cannot be its own source/);
  });

  it("rejects a sourceId that does not exist", () => {
    const id = createDraft();
    expect(() =>
      invoke(CHANNELS.updatePost, wsId, id, { frontMatter: { sourceId: "missing" } }),
    ).toThrow(/Source post not found/);
  });

  it("refuses to edit a locked post, whatever its status", () => {
    const id = createDraft();
    invoke(CHANNELS.setPostLocked, wsId, id, true);
    expect(() => invoke(CHANNELS.updatePost, wsId, id, { content: "x" })).toThrow(/This post is locked/);
    expect(() => invoke(CHANNELS.updatePost, wsId, id, { frontMatter: { sourceId: null } })).toThrow(/This post is locked/);
  });

  it("edits a published post that is not locked", () => {
    const id = createDraft();
    invoke(CHANNELS.changePostStatus, wsId, id, "published");
    const updated = invoke<PostMutationResult>(CHANNELS.updatePost, wsId, id, { content: "Fixed a typo." });
    expect(updated.content).toBe("Fixed a typo.");
    expect(updated.frontMatter.status).toBe("published");
  });
});

describe("changePostStatus", () => {
  it("advances draft -> verified -> published, stamping the status times", () => {
    const id = createDraft();

    const verified = invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "verified");
    expect(verified.frontMatter.status).toBe("verified");
    expect(verified.frontMatter.verifiedAtUtc).toBeTruthy();
    expect(verified.summary?.id).toBe(id);

    const published = invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "published");
    expect(published.frontMatter.status).toBe("published");
    expect(published.frontMatter.publishedAtUtc).toBeTruthy();
  });

  it("rejects an invalid status", () => {
    const id = createDraft();
    expect(() => invoke(CHANNELS.changePostStatus, wsId, id, "gone" as PostStatus)).toThrow(/Invalid status/);
  });

  it("throws 'Post not found' for an unknown id", () => {
    expect(() => invoke(CHANNELS.changePostStatus, wsId, "missing", "verified")).toThrow(/Post not found/);
  });

  it("changes the status of a locked post", () => {
    const id = createDraft();
    invoke(CHANNELS.setPostLocked, wsId, id, true);
    const retired = invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "retired");
    expect(retired.frontMatter.status).toBe("retired");
    expect(retired.frontMatter.locked).toBe(true);
  });
});

describe("setPostLocked", () => {
  it("locks and unlocks, returning the post and its summary", () => {
    const id = createDraft();
    const locked = invoke<PostMutationResult>(CHANNELS.setPostLocked, wsId, id, true);
    expect(locked.frontMatter.locked).toBe(true);
    expect(locked.summary?.locked).toBe(true);

    const unlocked = invoke<PostMutationResult>(CHANNELS.setPostLocked, wsId, id, false);
    expect(unlocked.frontMatter.locked).toBeUndefined();
    expect(unlocked.summary?.locked).toBeUndefined();
  });

  it("changes no time", () => {
    const id = createDraft();
    const before = invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "published").frontMatter;
    const after = invoke<PostMutationResult>(CHANNELS.setPostLocked, wsId, id, true).frontMatter;
    expect(after.updatedAtUtc).toBe(before.updatedAtUtc);
    expect(after.verifiedAtUtc).toBe(before.verifiedAtUtc);
    expect(after.publishedAtUtc).toBe(before.publishedAtUtc);
  });

  it("rejects a value that is not a boolean, and an unknown post", () => {
    const id = createDraft();
    expect(() => invoke(CHANNELS.setPostLocked, wsId, id, "yes")).toThrow(/must be a boolean/);
    expect(() => invoke(CHANNELS.setPostLocked, wsId, "missing", true)).toThrow(/Post not found/);
  });

  it("deletes a locked post", () => {
    const id = createDraft();
    invoke(CHANNELS.setPostLocked, wsId, id, true);
    invoke(CHANNELS.deletePost, wsId, id);
    expect(() => invoke(CHANNELS.getPost, wsId, id)).toThrow(/Post not found/);
  });
});

describe("deletePost", () => {
  it("deletes a post (returns undefined) and getPost then fails", () => {
    const id = createDraft();
    const result = invoke<void>(CHANNELS.deletePost, wsId, id);
    expect(result).toBeUndefined();
    expect(() => invoke(CHANNELS.getPost, wsId, id)).toThrow(/Post not found/);
  });

  it("throws 'Post not found' for an unknown id", () => {
    expect(() => invoke(CHANNELS.deletePost, wsId, "missing")).toThrow(/Post not found/);
  });
});

describe("listReferrers", () => {
  it("lists the posts that derive from a given source", () => {
    const source = createDraft();
    const child = createDraft("blogger", "en", source);

    const res = invoke<{ count: number; ids: string[] }>(CHANNELS.listReferrers, wsId, source);
    expect(res.count).toBe(1);
    expect(res.ids).toContain(child);
  });

  it("returns an empty list for a post no one references", () => {
    const lonely = createDraft();
    const res = invoke<{ count: number; ids: string[] }>(CHANNELS.listReferrers, wsId, lonely);
    expect(res.count).toBe(0);
    expect(res.ids).toEqual([]);
  });
});

// The content stream, end to end through the handler: the renderer's keystrokes
// go in one side and either land on disk or come back as a failure event. The
// store's own tests stop at its API; these assert what actually reaches a window
// — the seam where a save that never happened used to look like a save.
describe("queuePostContent (the content stream)", () => {
  function postFilePath(id: string): string {
    const dir = path.join(dataDir, "posts");
    const fileName = fs.readdirSync(dir).find((f) => f.includes(id));
    return path.join(dir, fileName ?? id);
  }

  function sends(channel: string): unknown[] {
    return sent.filter((s) => s.channel === channel).map((s) => s.payload);
  }

  it("writes the streamed text and broadcasts the canonical list projection", () => {
    vi.useFakeTimers();
    try {
      const id = createDraft();
      const file = postFilePath(id);
      sent.length = 0;

      invoke(CHANNELS.queuePostContent, wsId, id, "streamed from the editor");
      // The store owns the debounce; let it elapse.
      vi.advanceTimersByTime(1_000);

      // Durability first: a raw read, bypassing the store entirely.
      expect(fs.readFileSync(file, "utf8")).toContain("streamed from the editor");

      const saved = sends(CHANNELS.postContentSaved) as PostContentSavedEvent[];
      expect(saved).toHaveLength(1);
      expect(saved[0].postId).toBe(id);
      expect(saved[0].summary.id).toBe(id);
      expect(saved[0].summary.fileName).toBe(path.basename(file));
      // The payload is the index projection, which excludes updatedAtUtc — a
      // consumer must never be able to read an edit time off it.
      expect(saved[0].summary).not.toHaveProperty("updatedAtUtc");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unsaveable failure when the post's file vanished, and never a save", () => {
    vi.useFakeTimers();
    try {
      const id = createDraft();
      const file = postFilePath(id);
      invoke(CHANNELS.queuePostContent, wsId, id, "typed after the file was gone");
      fs.unlinkSync(file);
      sent.length = 0;

      vi.advanceTimersByTime(1_000);

      expect(sends(CHANNELS.postContentSaved)).toEqual([]);
      expect(sends(CHANNELS.postContentSaveFailed)).toEqual([
        { postId: id, kind: "unsaveable", message: expect.stringContaining("file is missing") },
      ]);
      // The store did not quietly recreate the file the user's sync client removed.
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unsaveable failure when the workspace cannot be resolved", () => {
    invoke(CHANNELS.queuePostContent, "nope", "p1", "text with nowhere to go");
    expect(sends(CHANNELS.postContentSaved)).toEqual([]);
    expect(sends(CHANNELS.postContentSaveFailed)).toEqual([
      { postId: "p1", kind: "unsaveable", message: expect.stringContaining("workspace") },
    ]);
  });

  it("ignores a malformed queue call (nothing to attribute a failure to)", () => {
    invoke(CHANNELS.queuePostContent, wsId, 42, "not a post id");
    expect(sent).toEqual([]);
  });
});

describe("queuePostMetadata (the metadata stream)", () => {
  function postFilePath(id: string): string {
    const dir = path.join(dataDir, "posts");
    const fileName = fs.readdirSync(dir).find((f) => f.includes(id));
    return path.join(dir, fileName ?? id);
  }

  it("buffers a field edit and writes it after the store's debounce", () => {
    vi.useFakeTimers();
    try {
      const id = createDraft();
      expect(invoke(CHANNELS.queuePostMetadata, wsId, id, { title: "Streamed Title" })).toBeNull();
      expect(fs.readFileSync(postFilePath(id), "utf8")).not.toContain("Streamed Title");

      vi.advanceTimersByTime(1_000);

      expect(fs.readFileSync(postFilePath(id), "utf8")).toContain("Streamed Title");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an invalid slug, a slug another post uses, and a non-metadata key", () => {
    const first = createDraft();
    const second = createDraft();
    expect(invoke(CHANNELS.queuePostMetadata, wsId, first, { slug: "shared" })).toBeNull();

    expect(invoke(CHANNELS.queuePostMetadata, wsId, second, { slug: "has space" })).toEqual({ key: "metadata.refusedInvalidSlug", values: { max: 200 } });
    expect(invoke(CHANNELS.queuePostMetadata, wsId, second, { slug: "Shared" })).toEqual({ key: "metadata.refusedSlugTaken", values: { slug: "Shared" } });
    expect(invoke(CHANNELS.queuePostMetadata, wsId, second, { target: "other" })).toEqual({ key: "metadata.refusedInvalid" });
  });

  it("refuses edits to a locked post and to one that is not there", () => {
    const id = createDraft();
    invoke(CHANNELS.setPostLocked, wsId, id, true);

    expect(invoke(CHANNELS.queuePostMetadata, wsId, id, { title: "Late" })).toEqual({ key: "metadata.refusedLocked" });
    expect(invoke(CHANNELS.queuePostMetadata, wsId, "missing", { title: "X" })).toEqual({ key: "metadata.refusedNotFound" });
  });
});

describe("rebuildPostIndex", () => {
  it("rebuilds the index and reports the post count", () => {
    createDraft();
    createDraft();
    const res = invoke<{
      count: number;
      skipped: number;
      duplicateSlugs: number;
      orphanedAssets: number;
    }>(CHANNELS.rebuildPostIndex, wsId);
    expect(res).toEqual({ count: 2, skipped: 0, duplicateSlugs: 0, orphanedAssets: 0 });
  });

  // The catch branch (rebuildIndex throwing) is not exercised: rebuildIndex only
  // throws on unreadable workspace files, which cannot be induced through the
  // public handler surface without corrupting the on-disk posts directory in a way
  // that is environment-specific and brittle. The success path is covered above.
});
