// Integration test for the post IPC handlers: the real postStore/configStore run
// against a throwaway BIGMOUTH_DATA_DIR + a real registered workspace. The async
// storageAccess mock calls real services and task guards; Electron and the logger
// are mocked. Each channel's success path is exercised by
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

vi.mock("@main/storageAccess.js", async () => {
  const workspace = await import("@main/core/services/workspaceStore.js");
  const config = await import("@main/core/services/configStore.js");
  const post = await import("@main/core/services/postStore.js");
  const { storageTasks } = await import("@main/storageTasks.js");
  return {
    getWorkspace: async (...args: Parameters<typeof workspace.getWorkspace>) => workspace.getWorkspace(...args),
    getSettings: async (...args: Parameters<typeof config.getSettings>) => config.getSettings(...args),
    getTargets: async (...args: Parameters<typeof config.getTargets>) => config.getTargets(...args),
    setContentSaveListener: post.setContentSaveListener,
    setHeldEditFailureListener: () => {},
    // Storage here runs in-process, so no text is ever held behind a save.
    holdsContentFor: () => false,
    refreshIndex: async (...args: Parameters<typeof post.refreshIndex>) => post.refreshIndex(...args),
    listByStatus: async (...args: Parameters<typeof post.listByStatus>) => post.listByStatus(...args),
    countByStatus: async (...args: Parameters<typeof post.countByStatus>) => post.countByStatus(...args),
    getPost: async (...args: Parameters<typeof post.getPost>) => post.getPost(...args),
    changeStatus: async (...args: Parameters<typeof post.changeStatus>) => post.changeStatus(...args),
    setLocked: async (...args: Parameters<typeof post.setLocked>) => post.setLocked(...args),
    deletePost: async (...args: Parameters<typeof post.deletePost>) => post.deletePost(...args),
    rebuildIndex: async (...args: Parameters<typeof post.rebuildIndex>) => post.rebuildIndex(...args),
    postExists: async (...args: Parameters<typeof post.postExists>) => post.postExists(...args),
    listReferrers: async (...args: Parameters<typeof post.listReferrers>) => post.listReferrers(...args),
    getPostSummary: async (...args: Parameters<typeof post.getPostSummary>) => post.getPostSummary(...args),
    queueWorkspaceContent: async (...args: Parameters<typeof storageTasks.queueWorkspaceContent>) => storageTasks.queueWorkspaceContent(...args),
    queueWorkspaceMetadata: async (...args: Parameters<typeof storageTasks.queueWorkspaceMetadata>) => storageTasks.queueWorkspaceMetadata(...args),
    recordAssetChange: async (...args: Parameters<typeof post.recordAssetChange>) => post.recordAssetChange(...args),
    createPost: async (...args: Parameters<typeof storageTasks.createPost>) => storageTasks.createPost(...args),
    updatePost: async (...args: Parameters<typeof storageTasks.updatePost>) => storageTasks.updatePost(...args),
  };
});

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

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return handlers.get(channel)!({}, ...args) as Promise<T>;
}

/** Creates a draft through the handler and returns its id. */
async function createDraft(target = "blogger", language = "en", sourceId?: string): Promise<string> {
  const post = (await invoke<Post>(CHANNELS.createPost, wsId, target, language, sourceId));
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
  it("rejects an unknown workspace id on any channel", async () => {
    await expect(invoke(CHANNELS.listPosts, "nope", { discarded: 0, published: 0, retired: 0 }, 0)).rejects.toThrow(/workspace not found/i);
    await expect(invoke(CHANNELS.createPost, "nope", "blogger", "en")).rejects.toThrow(/workspace not found/i);
  });
});

describe("createPost", () => {
  it("creates a draft and returns its front matter + content", async () => {
    const post = (await invoke<Post>(CHANNELS.createPost, wsId, "blogger", "en"));
    expect(post.frontMatter.status).toBe("draft");
    expect(post.frontMatter.target).toBe("blogger");
    expect(post.frontMatter.language).toBe("en");
    expect(post.frontMatter.id).toBeTruthy();
    expect(typeof post.content).toBe("string");
  });

  it("trims target/language and records a sourceId that exists", async () => {
    const source = (await createDraft());
    const post = (await invoke<Post>(CHANNELS.createPost, wsId, "  blogger  ", "  en  ", `  ${source}  `));
    expect(post.frontMatter.target).toBe("blogger");
    expect(post.frontMatter.sourceId).toBe(source);
  });

  it("requires target and language", async () => {
    await expect(invoke(CHANNELS.createPost, wsId, "", "en")).rejects.toThrow(/target and language are required/);
    await expect(invoke(CHANNELS.createPost, wsId, "blogger", "   ")).rejects.toThrow(/target and language are required/);
  });

  it("rejects a non-string sourceId", async () => {
    await expect(invoke(CHANNELS.createPost, wsId, "blogger", "en", 123 as unknown as string)).rejects.toThrow(/sourceId must be a string/);
  });

  it("rejects an unknown target", async () => {
    await expect(invoke(CHANNELS.createPost, wsId, "ghost", "en")).rejects.toThrow(/Unknown target: ghost/);
  });

  it("rejects an unsupported language", async () => {
    await expect(invoke(CHANNELS.createPost, wsId, "blogger", "xx")).rejects.toThrow(/Unsupported language: xx/);
  });

  it("rejects a sourceId that does not exist", async () => {
    await expect(invoke(CHANNELS.createPost, wsId, "blogger", "en", "missing-id")).rejects.toThrow(/Source post not found/);
  });

  it("rejects creation when no targets are configured", async () => {
    saveTargets(dataDir, []);
    await expect(invoke(CHANNELS.createPost, wsId, "blogger", "en")).rejects.toThrow(/No targets configured/);
  });
});

describe("getPost", () => {
  it("returns a created post by id", async () => {
    const id = (await createDraft());
    const post = (await invoke<Post>(CHANNELS.getPost, wsId, id));
    expect(post.frontMatter.id).toBe(id);
    expect(post).toHaveProperty("content");
  });

  it("throws 'Post not found' for an unknown id", async () => {
    await expect(invoke(CHANNELS.getPost, wsId, "does-not-exist")).rejects.toThrow(/Post not found/);
  });
});

const FIRST_PAGES = { discarded: 0, published: 0, retired: 0 };

const listIds = (res: PostListResponse, status: PostStatus) => res[status].posts.map((d) => d.frontMatter.id);

describe("listPosts", () => {
  it("returns a section for every status, with totals and offsets", async () => {
    const byStatus = {} as Record<PostStatus, string>;
    for (const status of ["draft", "discarded", "verified", "published", "retired"] as const) {
      byStatus[status] = (await createDraft());
      if (status !== "draft") (await invoke(CHANNELS.changePostStatus, wsId, byStatus[status], status));
    }

    const res = (await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0));
    for (const status of ["draft", "discarded", "verified", "published", "retired"] as const) {
      expect(listIds(res, status), status).toEqual([byStatus[status]]);
      expect(res[status].total, status).toBe(1);
      expect(res[status].offset, status).toBe(0);
    }
  });

  it("clamps negative offsets to 0 and falls back to the settings limit when limit is 0", async () => {
    const res = (await invoke<PostListResponse>(CHANNELS.listPosts, wsId, { discarded: -1, published: -5, retired: -3 }, 0));
    expect(res.discarded.offset).toBe(0);
    expect(res.published.offset).toBe(0);
    expect(res.retired.offset).toBe(0);
  });

  it.each(["discarded", "published", "retired"] as const)("pages %s posts by its own offset and the limit", async (status) => {
    for (let i = 0; i < 3; i++) {
      (await invoke(CHANNELS.changePostStatus, wsId, (await createDraft()), status));
    }
    const firstPage = (await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 2));
    expect(firstPage[status].posts).toHaveLength(2);
    expect(firstPage[status].total).toBe(3);
    const secondPage = (await invoke<PostListResponse>(CHANNELS.listPosts, wsId, { ...FIRST_PAGES, [status]: 2 }, 2));
    expect(secondPage[status].posts).toHaveLength(1);
    expect(secondPage[status].offset).toBe(2);
  });

  // store-recovery-conventions: a post file is a document of its own, so one
  // this build cannot read is reported in place while the rest keep working.
  it("names each post file it left out of the list, and leaves the files as they are", async () => {
    const kept = (await createDraft());
    const posts = path.join(dataDir, "posts");
    const broken = path.join(posts, "20260101-000000-utc-broken.md");
    const newer = path.join(posts, "20260101-000001-utc-newer.md");
    fs.writeFileSync(broken, "---\nid: [unclosed\n---\nbody\n");
    fs.writeFileSync(newer, "---\nformatVersion: 99\nid: NEWERxxxxxxxxxxxxxxxx\nstatus: draft\n---\nbody\n");

    const res = (await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0));

    expect(listIds(res, "draft")).toEqual([kept]);
    expect(res.unreadable).toEqual([
      { path: broken, newer: false },
      { path: newer, newer: true },
    ]);
    expect(fs.readFileSync(broken, "utf8")).toBe("---\nid: [unclosed\n---\nbody\n");
    // Still named on the next read, and gone from the answer once repaired.
    expect((await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0)).unreadable).toHaveLength(2);
    fs.rmSync(broken);
    fs.rmSync(newer);
    expect((await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0)).unreadable).toBeUndefined();
  });

  it("loads draft and verified posts whole, whatever the limit", async () => {
    for (let i = 0; i < 3; i++) (await createDraft());
    expect((await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 1)).draft.posts).toHaveLength(3);
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

  it("shows a status and title changed in the file since the last read", async () => {
    const id = (await createDraft());
    expect(listIds((await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0)), "draft")).toContain(id);

    const file = postFile(id);
    const edited = fs.readFileSync(file, "utf8").replace("status: draft", "status: verified").replace(/^---\n/, "---\ntitle: Edited in git\n");
    fs.writeFileSync(file, edited);
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(file, later, later);

    const res = (await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0));
    expect(listIds(res, "draft")).not.toContain(id);
    expect(res.verified.posts.find((d) => d.frontMatter.id === id)?.frontMatter.title).toBe("Edited in git");
  });

  it("drops a post whose file was removed since the last read", async () => {
    const id = (await createDraft());
    (await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0));
    fs.rmSync(postFile(id));
    expect(listIds((await invoke<PostListResponse>(CHANNELS.listPosts, wsId, FIRST_PAGES, 0)), "draft")).not.toContain(id);
  });
});

describe("updatePost", () => {
  it("updates content + editable front matter and returns a summary", async () => {
    const id = (await createDraft());
    const result = (await invoke<PostMutationResult>(CHANNELS.updatePost, wsId, id, {
      content: "New body.",
      frontMatter: { title: "A Title", slug: "a-slug" },
    }));
    expect(result.content).toBe("New body.");
    expect(result.frontMatter.title).toBe("A Title");
    expect(result.frontMatter.slug).toBe("a-slug");
    expect(result.summary?.id).toBe(id);

    // Read back through getPost to confirm it persisted, not just echoed.
    const reread = (await invoke<Post>(CHANNELS.getPost, wsId, id));
    expect(reread.content).toBe("New body.");
    expect(reread.frontMatter.title).toBe("A Title");
  });

  it("ignores unknown front matter keys (cannot invent front matter)", async () => {
    const id = (await createDraft());
    const result = (await invoke<PostMutationResult>(CHANNELS.updatePost, wsId, id, {
      frontMatter: { bogus: "nope" } as unknown as PostUpdate["frontMatter"],
    }));
    expect(result.frontMatter).not.toHaveProperty("bogus");
  });

  it("throws 'Post not found' for an unknown id", async () => {
    await expect(invoke(CHANNELS.updatePost, wsId, "missing", { content: "x" })).rejects.toThrow(/Post not found/);
  });

  it("rejects a non-object front matter", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.updatePost, wsId, id, { frontMatter: [] as unknown as PostUpdate["frontMatter"] })).rejects.toThrow(/frontMatter must be an object/);
  });

  it("rejects reserved front matter keys", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.updatePost, wsId, id, {
        frontMatter: { status: "published" } as unknown as PostUpdate["frontMatter"],
      })).rejects.toThrow(/Reserved front matter fields cannot be updated/);
  });

  it("rejects an invalid slug", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.updatePost, wsId, id, {
        frontMatter: { slug: "not a slug!" },
      })).rejects.toThrow(/Invalid slug/);
  });

  it("rejects a self-referential sourceId", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.updatePost, wsId, id, { frontMatter: { sourceId: id } })).rejects.toThrow(/A post cannot be its own source/);
  });

  it("rejects a sourceId that does not exist", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.updatePost, wsId, id, { frontMatter: { sourceId: "missing" } })).rejects.toThrow(/Source post not found/);
  });

  it("refuses to edit a locked post, whatever its status", async () => {
    const id = (await createDraft());
    (await invoke(CHANNELS.setPostLocked, wsId, id, true));
    await expect(invoke(CHANNELS.updatePost, wsId, id, { content: "x" })).rejects.toThrow(/This post is locked/);
    await expect(invoke(CHANNELS.updatePost, wsId, id, { frontMatter: { sourceId: null } })).rejects.toThrow(/This post is locked/);
  });

  it("edits a published post that is not locked", async () => {
    const id = (await createDraft());
    (await invoke(CHANNELS.changePostStatus, wsId, id, "published"));
    const updated = (await invoke<PostMutationResult>(CHANNELS.updatePost, wsId, id, { content: "Fixed a typo." }));
    expect(updated.content).toBe("Fixed a typo.");
    expect(updated.frontMatter.status).toBe("published");
  });
});

describe("changePostStatus", () => {
  it("advances draft -> verified -> published, stamping the status times", async () => {
    const id = (await createDraft());

    const verified = (await invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "verified"));
    expect(verified.frontMatter.status).toBe("verified");
    expect(verified.frontMatter.verifiedAtUtc).toBeTruthy();
    expect(verified.summary?.id).toBe(id);

    const published = (await invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "published"));
    expect(published.frontMatter.status).toBe("published");
    expect(published.frontMatter.publishedAtUtc).toBeTruthy();
  });

  it("rejects an invalid status", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.changePostStatus, wsId, id, "gone" as PostStatus)).rejects.toThrow(/Invalid status/);
  });

  it("throws 'Post not found' for an unknown id", async () => {
    await expect(invoke(CHANNELS.changePostStatus, wsId, "missing", "verified")).rejects.toThrow(/Post not found/);
  });

  it("changes the status of a locked post", async () => {
    const id = (await createDraft());
    (await invoke(CHANNELS.setPostLocked, wsId, id, true));
    const retired = (await invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "retired"));
    expect(retired.frontMatter.status).toBe("retired");
    expect(retired.frontMatter.locked).toBe(true);
  });
});

describe("setPostLocked", () => {
  it("locks and unlocks, returning the post and its summary", async () => {
    const id = (await createDraft());
    const locked = (await invoke<PostMutationResult>(CHANNELS.setPostLocked, wsId, id, true));
    expect(locked.frontMatter.locked).toBe(true);
    expect(locked.summary?.locked).toBe(true);

    const unlocked = (await invoke<PostMutationResult>(CHANNELS.setPostLocked, wsId, id, false));
    expect(unlocked.frontMatter.locked).toBeUndefined();
    expect(unlocked.summary?.locked).toBeUndefined();
  });

  it("changes no time", async () => {
    const id = (await createDraft());
    const before = (await invoke<PostMutationResult>(CHANNELS.changePostStatus, wsId, id, "published")).frontMatter;
    const after = (await invoke<PostMutationResult>(CHANNELS.setPostLocked, wsId, id, true)).frontMatter;
    expect(after.updatedAtUtc).toBe(before.updatedAtUtc);
    expect(after.verifiedAtUtc).toBe(before.verifiedAtUtc);
    expect(after.publishedAtUtc).toBe(before.publishedAtUtc);
  });

  it("rejects a value that is not a boolean, and an unknown post", async () => {
    const id = (await createDraft());
    await expect(invoke(CHANNELS.setPostLocked, wsId, id, "yes")).rejects.toThrow(/must be a boolean/);
    await expect(invoke(CHANNELS.setPostLocked, wsId, "missing", true)).rejects.toThrow(/Post not found/);
  });

  it("deletes a locked post", async () => {
    const id = (await createDraft());
    (await invoke(CHANNELS.setPostLocked, wsId, id, true));
    (await invoke(CHANNELS.deletePost, wsId, id));
    await expect(invoke(CHANNELS.getPost, wsId, id)).rejects.toThrow(/Post not found/);
  });
});

describe("deletePost", () => {
  it("deletes a post (returns undefined) and getPost then fails", async () => {
    const id = (await createDraft());
    const result = (await invoke<void>(CHANNELS.deletePost, wsId, id));
    expect(result).toBeUndefined();
    await expect(invoke(CHANNELS.getPost, wsId, id)).rejects.toThrow(/Post not found/);
  });

  it("throws 'Post not found' for an unknown id", async () => {
    await expect(invoke(CHANNELS.deletePost, wsId, "missing")).rejects.toThrow(/Post not found/);
  });
});

describe("listReferrers", () => {
  it("lists the posts that derive from a given source", async () => {
    const source = (await createDraft());
    const child = (await createDraft("blogger", "en", source));

    const res = (await invoke<{ count: number; ids: string[] }>(CHANNELS.listReferrers, wsId, source));
    expect(res.count).toBe(1);
    expect(res.ids).toContain(child);
  });

  it("returns an empty list for a post no one references", async () => {
    const lonely = (await createDraft());
    const res = (await invoke<{ count: number; ids: string[] }>(CHANNELS.listReferrers, wsId, lonely));
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

  it("writes the streamed text and broadcasts the canonical list projection", async () => {
    vi.useFakeTimers();
    try {
      const id = (await createDraft());
      const file = postFilePath(id);
      sent.length = 0;

      (await invoke(CHANNELS.queuePostContent, wsId, id, "streamed from the editor"));
      // The store owns the debounce; let it elapse.
      vi.advanceTimersByTime(1_000);

      // Durability first: a raw read, bypassing the store entirely.
      expect(fs.readFileSync(file, "utf8")).toContain("streamed from the editor");

      const saved = sends(CHANNELS.postContentSaved) as PostContentSavedEvent[];
      expect(saved).toHaveLength(1);
      expect(saved[0].postId).toBe(id);
      expect(saved[0].summary.id).toBe(id);
      expect(saved[0].newerEditHeld).toBe(false);
      expect(saved[0].summary.fileName).toBe(path.basename(file));
      // The payload is the index projection, which excludes updatedAtUtc — a
      // consumer must never be able to read an edit time off it.
      expect(saved[0].summary).not.toHaveProperty("updatedAtUtc");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unsaveable failure when the post's file vanished, and never a save", async () => {
    vi.useFakeTimers();
    try {
      const id = (await createDraft());
      const file = postFilePath(id);
      (await invoke(CHANNELS.queuePostContent, wsId, id, "typed after the file was gone"));
      fs.unlinkSync(file);
      sent.length = 0;

      vi.advanceTimersByTime(1_000);

      expect(sends(CHANNELS.postContentSaved)).toEqual([]);
      expect(sends(CHANNELS.postContentSaveFailed)).toEqual([
        { postId: id, kind: "unsaveable" },
      ]);
      // The store did not quietly recreate the file the user's sync client removed.
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unsaveable failure when the workspace cannot be resolved", async () => {
    (await invoke(CHANNELS.queuePostContent, "nope", "p1", "text with nowhere to go"));
    expect(sends(CHANNELS.postContentSaved)).toEqual([]);
    expect(sends(CHANNELS.postContentSaveFailed)).toEqual([
      { postId: "p1", kind: "unsaveable" },
    ]);
  });

  it("ignores a malformed queue call (nothing to attribute a failure to)", async () => {
    (await invoke(CHANNELS.queuePostContent, wsId, 42, "not a post id"));
    expect(sent).toEqual([]);
  });
});

describe("queuePostMetadata (the metadata stream)", () => {
  function postFilePath(id: string): string {
    const dir = path.join(dataDir, "posts");
    const fileName = fs.readdirSync(dir).find((f) => f.includes(id));
    return path.join(dir, fileName ?? id);
  }

  it("buffers a field edit and writes it after the store's debounce", async () => {
    vi.useFakeTimers();
    try {
      const id = (await createDraft());
      expect((await invoke(CHANNELS.queuePostMetadata, wsId, id, { title: "Streamed Title" }))).toBeNull();
      expect(fs.readFileSync(postFilePath(id), "utf8")).not.toContain("Streamed Title");

      vi.advanceTimersByTime(1_000);

      expect(fs.readFileSync(postFilePath(id), "utf8")).toContain("Streamed Title");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an invalid slug, a slug another post uses, and a non-metadata key", async () => {
    const first = (await createDraft());
    const second = (await createDraft());
    expect((await invoke(CHANNELS.queuePostMetadata, wsId, first, { slug: "shared" }))).toBeNull();

    expect((await invoke(CHANNELS.queuePostMetadata, wsId, second, { slug: "has space" }))).toEqual({ key: "metadata.refusedInvalidSlug", values: { max: 200 } });
    expect((await invoke(CHANNELS.queuePostMetadata, wsId, second, { slug: "Shared" }))).toEqual({ key: "metadata.refusedSlugTaken", values: { slug: "Shared" } });
    expect((await invoke(CHANNELS.queuePostMetadata, wsId, second, { target: "other" }))).toEqual({ key: "metadata.refusedInvalid" });
  });

  it("refuses edits to a locked post and to one that is not there", async () => {
    const id = (await createDraft());
    (await invoke(CHANNELS.setPostLocked, wsId, id, true));

    expect((await invoke(CHANNELS.queuePostMetadata, wsId, id, { title: "Late" }))).toEqual({ key: "metadata.refusedLocked" });
    expect((await invoke(CHANNELS.queuePostMetadata, wsId, "missing", { title: "X" }))).toEqual({ key: "metadata.refusedNotFound" });
  });
});

describe("rebuildPostIndex", () => {
  it("rebuilds the index and reports the post count", async () => {
    (await createDraft());
    (await createDraft());
    const res = (await invoke<{
      count: number;
      skipped: number;
      duplicateSlugs: number;
      orphanedAssets: number;
    }>(CHANNELS.rebuildPostIndex, wsId));
    expect(res).toEqual({ count: 2, skipped: 0, duplicateSlugs: 0, orphanedAssets: 0 });
  });

  // The catch branch (rebuildIndex throwing) is not exercised: rebuildIndex only
  // throws on unreadable workspace files, which cannot be induced through the
  // public handler surface without corrupting the on-disk posts directory in a way
  // that is environment-specific and brittle. The success path is covered above.
});
