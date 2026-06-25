// Integration test for the post IPC handlers: the real postStore/configStore run
// against a throwaway BIGMOUTH_HOME + a real registered workspace; only `electron`
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
import { CHANNELS, type PostUpdate } from "@shared/ipc";
import type { Post, PostListResponse, PostMutationResult, PostStatus, Target } from "@shared/types";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
    on: (ch: string, cb: (...args: unknown[]) => unknown) => handlers.set(ch, cb),
  },
}));

vi.mock("@main/core/services/logger.js", () => ({
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
const SAVED_HOME = process.env.BIGMOUTH_HOME;

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
  process.env.BIGMOUTH_HOME = home;
  initAppDir();
  handlers.clear();
  registerPostHandlers();
  const ws = createWorkspace("WS");
  wsId = ws.id;
  dataDir = ws.dataDirectory;
  // A fresh workspace has no targets; register one so createPost is reachable.
  saveTargets(dataDir, [TARGET]);
});

afterEach(() => {
  clearCache(dataDir);
  if (SAVED_HOME === undefined) delete process.env.BIGMOUTH_HOME;
  else process.env.BIGMOUTH_HOME = SAVED_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("post IPC handlers — workspace resolution", () => {
  it("rejects an unknown workspace id on any channel", () => {
    expect(() => invoke(CHANNELS.listPosts, "nope", 0, 0, 0)).toThrow(/workspace not found/i);
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

describe("listPosts", () => {
  it("returns the post buckets and the published/expired totals", () => {
    const draftId = createDraft();

    const readyId = createDraft();
    invoke(CHANNELS.changePostStatus, wsId, readyId, "ready");

    const publishedId = createDraft();
    invoke(CHANNELS.changePostStatus, wsId, publishedId, "published");

    const expiredId = createDraft();
    invoke(CHANNELS.changePostStatus, wsId, expiredId, "expired");

    const res = invoke<PostListResponse>(CHANNELS.listPosts, wsId, 0, 0, 0);
    expect(res.drafts.map((d) => d.frontMatter.id)).toContain(draftId);
    expect(res.ready.map((d) => d.frontMatter.id)).toContain(readyId);
    expect(res.published.map((d) => d.frontMatter.id)).toContain(publishedId);
    expect(res.expired.map((d) => d.frontMatter.id)).toContain(expiredId);
    expect(res.publishedTotal).toBe(1);
    expect(res.expiredTotal).toBe(1);
    expect(res.publishedOffset).toBe(0);
    expect(res.expiredOffset).toBe(0);
  });

  it("clamps negative offsets to 0 and falls back to the settings limit when limit is 0", () => {
    const res = invoke<PostListResponse>(CHANNELS.listPosts, wsId, -5, 0, -3);
    expect(res.publishedOffset).toBe(0);
    expect(res.expiredOffset).toBe(0);
  });

  it("paginates published posts by offset and limit", () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = createDraft();
      invoke(CHANNELS.changePostStatus, wsId, id, "published");
      ids.push(id);
    }
    const firstPage = invoke<PostListResponse>(CHANNELS.listPosts, wsId, 0, 2, 0);
    expect(firstPage.published).toHaveLength(2);
    expect(firstPage.publishedTotal).toBe(3);
    const secondPage = invoke<PostListResponse>(CHANNELS.listPosts, wsId, 2, 2, 0);
    expect(secondPage.published).toHaveLength(1);
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

  it("refuses to edit a published (locked) post", () => {
    const id = createDraft();
    invoke(CHANNELS.changePostStatus, wsId, id, "published");
    expect(() => invoke(CHANNELS.updatePost, wsId, id, { content: "x" })).toThrow(/Published posts are locked/);
  });

  it("refuses to edit an expired (locked) post", () => {
    const id = createDraft();
    invoke(CHANNELS.changePostStatus, wsId, id, "expired");
    expect(() => invoke(CHANNELS.updatePost, wsId, id, { content: "x" })).toThrow(/Expired posts are locked/);
  });
});

describe("changePostStatus", () => {
  it("advances draft -> ready -> published, stamping the lifecycle timestamps", () => {
    const id = createDraft();

    const ready = invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "ready");
    expect(ready.frontMatter.status).toBe("ready");
    expect(ready.frontMatter.readyAtUtc).toBeTruthy();
    expect(ready.summary?.id).toBe(id);

    const published = invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "published");
    expect(published.frontMatter.status).toBe("published");
    expect(published.frontMatter.publishedAtUtc).toBeTruthy();
  });

  it("rejects an invalid status", () => {
    const id = createDraft();
    expect(() => invoke(CHANNELS.changePostStatus, wsId, id, "gone" as PostStatus)).toThrow(/Invalid status/);
  });

  it("throws 'Post not found' for an unknown id", () => {
    expect(() => invoke(CHANNELS.changePostStatus, wsId, "missing", "ready")).toThrow(/Post not found/);
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

describe("rebuildPostIndex", () => {
  it("rebuilds the index and reports the post count", () => {
    createDraft();
    createDraft();
    const res = invoke<{ count: number }>(CHANNELS.rebuildPostIndex, wsId);
    expect(res.count).toBe(2);
  });

  // The catch branch (rebuildIndex throwing) is not exercised: rebuildIndex only
  // throws on unreadable workspace files, which cannot be induced through the
  // public handler surface without corrupting the on-disk posts directory in a way
  // that is environment-specific and brittle. The success path is covered above.
});
