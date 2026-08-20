import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { PostFrontMatter } from "@main/core/shared/types.js";
import { readPost, writePost, parsePostRaw } from "@main/core/services/postFile.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-postfile-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function frontMatter(): PostFrontMatter {
  return {
    id: "post-1",
    status: "draft",
    createdAtUtc: "2026-08-21T00:00:00.000Z",
    updatedAtUtc: "2026-08-21T00:00:00.000Z",
  } as PostFrontMatter;
}

function roundTrip(body: string): string {
  const file = path.join(dir, "post.md");
  writePost(file, frontMatter(), body);
  return readPost(file).content;
}

describe("a body is data, never a document to re-parse", () => {
  // The body used to be handed to gray-matter as a bare string, which re-parses
  // it as a document. A post opening with `---` therefore had its text read as
  // YAML: the body was erased from disk and its characters written back out as
  // numbered front-matter keys, with the write-behind buffer cleared afterwards
  // so nothing could restore it. Total loss of the user's work, on autosave.
  it("keeps a body that opens with a thematic break", () => {
    const body = "---\n\nMy whole draft lives here and it is important.";
    expect(roundTrip(body)).toBe(body);
  });

  it("keeps a body that opens with a complete YAML block, and leaks no keys into the front matter", () => {
    const body = "---\nfoo: bar\n---\n\nRest of the post.";
    const file = path.join(dir, "post.md");
    writePost(file, frontMatter(), body);

    const post = readPost(file);
    expect(post.content).toBe(body);
    expect(post.frontMatter).not.toHaveProperty("foo");
    // The character-indexed keys the old shape produced.
    expect(post.frontMatter).not.toHaveProperty("0");
  });

  it("leaves an ordinary body byte-identical", () => {
    const body = "Normal body text.\n\nWith a second paragraph and a --- mid-line.";
    expect(roundTrip(body)).toBe(body);
  });
});

// gray-matter's module-global cache is real but undeclared in its types, so the
// leak regression below reaches it through one narrow cast rather than loosening
// the import for the whole file.
const grayMatterCache = matter as unknown as {
  cache: Record<string, unknown>;
  clearCache: () => void;
};

describe("parsing does not accumulate in gray-matter's global cache", () => {
  // Called with no options, gray-matter memoizes every parse by the whole input
  // string and never evicts, so each autosave flush retained another full copy
  // of the post for the life of the process.
  it("adds nothing to the module-global cache", () => {
    grayMatterCache.clearCache();
    const before = Object.keys(grayMatterCache.cache).length;

    for (let i = 0; i < 50; i++) {
      parsePostRaw(`---\nid: post-1\nstatus: draft\n---\n\nversion ${i}\n`);
    }

    expect(Object.keys(grayMatterCache.cache).length).toBe(before);
  });

  it("gives each caller its own front-matter object to mutate", () => {
    const raw = "---\nid: post-1\nstatus: draft\ntitle: Shared\n---\n\nBody\n";
    const first = parsePostRaw(raw);
    const second = parsePostRaw(raw);

    (first.frontMatter as { title?: string }).title = "Mutated";

    expect(second.frontMatter.title).toBe("Shared");
  });
});
