import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPostStoreFixture } from "./postStore-fixture.js";

describe("post-store fixture lifetime", () => {
  it.each(["success", "assertion failure", "terminal failure"])("leaves no earlier work after %s", async (outcome) => {
    vi.useFakeTimers();
    const first = await createPostStoreFixture();
    let second: Awaited<ReturnType<typeof createPostStoreFixture>> | undefined;
    try {
      try {
        const post = first.store.createPost(first.dataDir, "blogger", "en");
        first.store.queueContent(first.dataDir, post.frontMatter.id, "pending fixture edit");
        if (outcome === "terminal failure") {
          fs.unlinkSync(post.filePath);
          expect(first.store.flushPostEdits(first.dataDir, post.frontMatter.id)).toBe(false);
        }
        if (outcome === "assertion failure") throw new Error("simulated assertion failure");
      } catch (error) {
        expect(error).toEqual(new Error("simulated assertion failure"));
      } finally {
        first.dispose();
      }
      second = await createPostStoreFixture();
      const events = vi.fn();
      second.store.setContentSaveListener(events);
      vi.advanceTimersByTime(60_000);
      expect(events).not.toHaveBeenCalled();
      expect(second.store.flushAllPendingEdits()).toEqual([]);
      expect(fs.existsSync(first.dataDir)).toBe(false);
    } finally {
      second?.dispose();
      vi.useRealTimers();
    }
  });

  it("removes its owned root when setup fails partway through", async () => {
    const mkdir = fs.mkdirSync;
    let failedRoot = "";
    const fail = vi.spyOn(fs, "mkdirSync").mockImplementation((directory, options) => {
      if (path.basename(String(directory)) === "assets") {
        failedRoot = path.dirname(String(directory));
        throw new Error("simulated setup failure");
      }
      return mkdir(directory, options);
    });
    try {
      await expect(createPostStoreFixture()).rejects.toThrow("simulated setup failure");
      expect(failedRoot).not.toBe("");
      expect(fs.existsSync(failedRoot)).toBe(false);
    } finally { fail.mockRestore(); }
  });
});
