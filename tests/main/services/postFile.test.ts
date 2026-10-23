import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { PostFrontMatter } from "@main/core/shared/types.js";
import { readPost, writePost, parsePostRaw, projectIndexEntry } from "@main/core/services/postFile.js";
import { rebuild, clearCache as clearIndexCache } from "@main/core/services/postIndex.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-postfile-"));
});

afterEach(() => {
  clearIndexCache(dir);
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
  // Handed to gray-matter as a bare string, the body would be re-parsed as a
  // document. A post opening with `---` would have its text read as YAML: the
  // body erased from disk and its characters written back out as numbered
  // front-matter keys, with the write-behind buffer cleared afterwards so
  // nothing could restore it. Total loss of the user's work, on autosave.
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
    // The character-indexed keys a re-parsed body would produce.
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

describe("saving a changed post", () => {
  it.runIf(process.platform !== "win32")("keeps the permissions the file already had", () => {
    const file = path.join(dir, "post.md");
    writePost(file, frontMatter(), "first");
    fs.chmodSync(file, 0o640);
    writePost(file, frontMatter(), "second");
    expect(readPost(file).content).toBe("second");
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });
});

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

describe("front matter is YAML data", () => {
  it.each(["javascript", "js", "JS", "JavaScript", "json", "JSON", "coffee", "__proto__"])(
    "rejects a file-selected %s engine before it can evaluate metadata",
    (language) => {
      const marker = globalThis as typeof globalThis & { bigmouthFrontMatterExecuted?: boolean };
      const raw = `---${language}\n(globalThis.bigmouthFrontMatterExecuted = true, { id: "post-1", status: "draft" })\n---\nBody`;
      const file = path.join(dir, "posts", "post.md");
      fs.mkdirSync(path.dirname(file));
      fs.writeFileSync(file, raw);
      try {
        expect(() => parsePostRaw(raw)).toThrow("must use YAML");
        expect(() => parsePostRaw(`\uFEFF${raw}`)).toThrow("must use YAML");
        expect(() => readPost(file)).toThrow("must use YAML");
        expect(rebuild(dir)).toMatchObject({ indexed: 0, skipped: [{ fileName: "post.md" }] });
        expect(marker.bigmouthFrontMatterExecuted).toBeUndefined();
        expect(fs.readFileSync(file, "utf-8")).toBe(raw);
      } finally {
        delete marker.bigmouthFrontMatterExecuted;
      }
    },
  );

  it.each(["", "yaml", "yml", "YAML"])("preserves ordinary YAML with delimiter language %j", (language) => {
    const raw = `---${language}\nid: post-1\nstatus: draft\ntitle: A title\ncustom:\n  enabled: true\n---\n\n---\nbody: stays body\n---\n`;
    const post = parsePostRaw(raw);
    expect(post.frontMatter).toMatchObject({ id: "post-1", title: "A title", custom: { enabled: true } });
    expect(post.content).toBe("---\nbody: stays body\n---");
  });

  it.each(["null", "42", "a scalar", "2026-10-23", "!!binary aGVsbG8=", "- first\n- second"])("rejects non-map YAML %j", (metadata) => {
    expect(() => parsePostRaw(`---\n${metadata}\n---\nBody`)).toThrow("must be a YAML map");
  });

  it("normalizes empty optional text and indexes an empty slug without writing the file", () => {
    const raw = "---\nid: post-1\nstatus: draft\nslug:\ntitle: null\nextra:\n---\n\nBody";
    const file = path.join(dir, "posts", "post.md");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, raw);
    const post = readPost(file);
    expect(post.frontMatter).not.toHaveProperty("slug");
    expect(post.frontMatter).not.toHaveProperty("title");
    expect(post.frontMatter).not.toHaveProperty("extra");
    expect(projectIndexEntry(post.frontMatter, "post.md", post.content)).toMatchObject({ id: "post-1", excerpt: "Body" });
    expect(rebuild(dir)).toMatchObject({ indexed: 1, skipped: [] });
    expect(fs.readFileSync(file, "utf-8")).toBe(raw);
  });
});
