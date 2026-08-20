/**
 * Post index store.
 *
 * The index is a derived catalog of every post's front-matter projection, kept
 * in memory per workspace and persisted to `posts/index.json`. The Markdown
 * files are the source of truth; the index is rebuildable from them and exists
 * to (1) serve the published archive cheaply, (2) resolve id → file, and
 * (3) back search — all without reading thousands of bodies.
 *
 * Every mutation is a single row operation (`upsertEntry`, `removeEntry`).
 * Today they are backed by an in-memory map plus a canonical JSON file; the
 * same operations map directly onto SQLite UPSERT/DELETE, so swapping the
 * backend is mechanical and leaves callers untouched.
 *
 * `upsertEntry` is write-gated: an entry equal to the stored one is a no-op, so
 * a content-only autosave (which changes only updatedAtUtc, not the projection)
 * never rewrites the file.
 */

import fs from "node:fs";
import path from "node:path";
import type { PostStatus, PostIndexEntry } from "../shared/types.js";
import { readPost, projectIndexEntry } from "./postFile.js";
import { writeManagedText } from "../shared/atomicWrite.js";
import { compareInstants } from "../shared/timestamps.js";
import { warn as logWarn } from "./logger.js";
import { isPostStatus } from "../shared/postLifecycle.js";

// One map per workspace data directory, keyed by post id.
const indexes = new Map<string, Map<string, PostIndexEntry>>();

function postsDir(dataDir: string): string {
  return path.join(dataDir, "posts");
}

function indexPath(dataDir: string): string {
  return path.join(postsDir(dataDir), "index.json");
}

// --- Public API ---

export function clearCache(dataDir: string): void {
  indexes.delete(dataDir);
}

export function getEntry(dataDir: string, id: string): PostIndexEntry | null {
  return state(dataDir).get(id) ?? null;
}

export function allEntries(dataDir: string): PostIndexEntry[] {
  return [...state(dataDir).values()];
}

export function listByStatus(dataDir: string, status: PostStatus): PostIndexEntry[] {
  return allEntries(dataDir).filter((entry) => entry.status === status);
}

export function countByStatus(dataDir: string, status: PostStatus): number {
  let count = 0;
  for (const entry of state(dataDir).values()) {
    if (entry.status === status) count++;
  }
  return count;
}

/**
 * Inserts or updates a row. No-ops (and skips the disk write) when the entry is
 * byte-for-byte identical to the stored one.
 */
export function upsertEntry(dataDir: string, entry: PostIndexEntry): void {
  const map = state(dataDir);
  const existing = map.get(entry.id);
  if (existing && canonicalEntryJson(existing) === canonicalEntryJson(entry)) return;
  map.set(entry.id, entry);
  persist(dataDir, map);
}

export function removeEntry(dataDir: string, id: string): void {
  const map = state(dataDir);
  if (!map.delete(id)) return;
  persist(dataDir, map);
}

/** What a rebuild found: how many posts are indexed, and every file it could not use. */
export interface RebuildResult {
  indexed: number;
  skipped: { fileName: string; reason: string }[];
}

/**
 * Rebuilds the entire index from the `.md` files on disk and persists it.
 * Deterministic: the same set of files always yields a byte-identical file.
 *
 * Returns what it skipped as well as what it indexed. It used to return only a
 * count, so a post whose front matter had been hand-edited into something
 * unreadable simply vanished from every list while the rebuild reported success
 * — and the rebuild is offered to the user precisely because the app invites
 * editing those files outside it.
 */
export function rebuild(dataDir: string): RebuildResult {
  const { map, skipped } = buildFromDisk(dataDir);
  indexes.set(dataDir, map);
  persist(dataDir, map);
  return { indexed: map.size, skipped };
}

// --- Internal ---

function state(dataDir: string): Map<string, PostIndexEntry> {
  let map = indexes.get(dataDir);
  if (!map) {
    map = load(dataDir);
    indexes.set(dataDir, map);
  }
  return map;
}

/**
 * Loads the index for a workspace: parse `index.json` if present and valid,
 * otherwise rebuild from disk. Either way, reconcile against the actual files
 * (cheap — a directory listing, plus a read only of files the index is missing)
 * and persist if anything drifted, so a stale or crash-truncated index heals on
 * first use.
 */
function load(dataDir: string): Map<string, PostIndexEntry> {
  const parsed = readIndexFile(dataDir);
  if (!parsed) return buildAndPersist(dataDir);

  const changed = reconcile(dataDir, parsed);
  if (changed) persist(dataDir, parsed);
  return parsed;
}

function buildAndPersist(dataDir: string): Map<string, PostIndexEntry> {
  const { map } = buildFromDisk(dataDir);
  persist(dataDir, map);
  return map;
}

function readIndexFile(dataDir: string): Map<string, PostIndexEntry> | null {
  const filePath = indexPath(dataDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!Array.isArray(parsed)) return null;
    const map = new Map<string, PostIndexEntry>();
    for (const item of parsed as PostIndexEntry[]) {
      if (item && typeof item.id === "string") map.set(item.id, item);
    }
    return map;
  } catch {
    // Corrupt index — treat as absent and rebuild from the source of truth.
    return null;
  }
}

function buildFromDisk(dataDir: string): {
  map: Map<string, PostIndexEntry>;
  skipped: { fileName: string; reason: string }[];
} {
  const map = new Map<string, PostIndexEntry>();
  const skipped: { fileName: string; reason: string }[] = [];
  for (const fileName of postFileNames(dataDir)) {
    const result = tryEntryFromFile(dataDir, fileName);
    if ("reason" in result) {
      skipped.push({ fileName, reason: result.reason });
      continue;
    }
    if (!insertUnique(map, result.entry)) {
      skipped.push({ fileName, reason: `duplicate post id ${result.entry.id}` });
    }
  }
  return { map, skipped };
}

/**
 * Reconciles an in-memory index against the files on disk by filename:
 * adds files the index is missing, drops entries whose file is gone. Returns
 * whether anything changed. Does not detect an out-of-band edit to an existing
 * file (same name) — `rebuild()` is the remedy for that.
 */
function reconcile(dataDir: string, map: Map<string, PostIndexEntry>): boolean {
  const onDisk = new Set(postFileNames(dataDir));
  const indexed = new Set<string>();
  for (const entry of map.values()) indexed.add(entry.fileName);

  let changed = false;

  for (const fileName of onDisk) {
    if (indexed.has(fileName)) continue;
    const result = tryEntryFromFile(dataDir, fileName);
    if ("entry" in result && insertUnique(map, result.entry)) changed = true;
  }

  for (const [id, entry] of [...map.entries()]) {
    if (!onDisk.has(entry.fileName)) {
      map.delete(id);
      changed = true;
    }
  }

  return changed;
}

/**
 * Reads one post file into an index entry, or says why it cannot contribute one
 * — unreadable, malformed front matter, no id, or a status outside the four. A
 * bad source file is skipped and logged, never thrown: the index is a derived
 * cache and must tolerate a corrupt or half-written `.md` the same way
 * `readIndexFile` tolerates a corrupt `index.json`, rather than letting one bad
 * file make the whole workspace unreadable. The REASON travels back so a
 * rebuild the user asked for can say what it left behind.
 */
function tryEntryFromFile(
  dataDir: string,
  fileName: string,
): { entry: PostIndexEntry } | { reason: string } {
  try {
    const post = readPost(path.join(postsDir(dataDir), fileName));
    if (!post.frontMatter.id) {
      const reason = "no id in its front matter";
      logWarn("post file skipped", { fileName, reason });
      return { reason };
    }
    // A status outside the four reaches no bucket, so an entry built from it
    // would sit in the index describing a post no list can show — indexed by
    // the count, invisible in the app.
    if (!isPostStatus(post.frontMatter.status)) {
      const reason = `unknown status ${JSON.stringify(post.frontMatter.status)}`;
      logWarn("post file skipped", { fileName, reason });
      return { reason };
    }
    return { entry: projectIndexEntry(post.frontMatter, fileName, post.content) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarn("post file skipped", { fileName, reason });
    return { reason };
  }
}

/**
 * Inserts an entry under its id, keeping the first file seen for a given id and
 * logging any later collision rather than throwing or silently overwriting.
 * Callers iterate files in sorted order, so the surviving file is deterministic.
 * Returns whether the entry was inserted.
 */
function insertUnique(map: Map<string, PostIndexEntry>, entry: PostIndexEntry): boolean {
  const existing = map.get(entry.id);
  if (existing) {
    logWarn("post file skipped: duplicate id", {
      id: entry.id,
      kept: existing.fileName,
      ignored: entry.fileName,
    });
    return false;
  }
  map.set(entry.id, entry);
  return true;
}

function postFileNames(dataDir: string): string[] {
  const dir = postsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

function persist(dataDir: string, map: Map<string, PostIndexEntry>): void {
  // recorded: posts/index.json is a durable managed JSON store — it sits in the text-bearing posts/
  // directory (NOT a binary-bearing one), and it carries user-authored derived text (titles, slugs,
  // excerpts). Though rebuildable from the .md files, the default is to record every managed text store,
  // and write-gating (upsert no-ops) plus the store's own dedup absorb its churn (data-backup
  // conventions: every durable JSON store is recorded).
  writeManagedText(indexPath(dataDir), canonicalIndexJson([...map.values()]));
}

// --- Canonical serialization (byte-identical across rebuilds) ---

/**
 * Serializes entries deterministically: sorted by (createdAtUtc instant, id),
 * each entry written with a fixed key order and absent optionals omitted,
 * 2-space indent, trailing newline.
 */
export function canonicalIndexJson(entries: PostIndexEntry[]): string {
  const sorted = [...entries].sort(compareEntries);
  const canonical = sorted.map(canonicalEntryObject);
  return JSON.stringify(canonical, null, 2) + "\n";
}

function compareEntries(a: PostIndexEntry, b: PostIndexEntry): number {
  const byInstant = compareInstants(a.createdAtUtc, b.createdAtUtc);
  if (byInstant !== 0) return byInstant;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function canonicalEntryObject(entry: PostIndexEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: entry.id,
    fileName: entry.fileName,
    status: entry.status,
    target: entry.target,
    language: entry.language,
  };
  if (entry.slug !== undefined) out.slug = entry.slug;
  if (entry.title !== undefined) out.title = entry.title;
  if (entry.titleEn !== undefined) out.titleEn = entry.titleEn;
  if (entry.excerpt !== undefined) out.excerpt = entry.excerpt;
  if (entry.tags !== undefined) out.tags = entry.tags;
  if (entry.sourceId !== undefined) out.sourceId = entry.sourceId;
  out.createdAtUtc = entry.createdAtUtc;
  if (entry.readyAtUtc !== undefined) out.readyAtUtc = entry.readyAtUtc;
  if (entry.publishedAtUtc !== undefined) out.publishedAtUtc = entry.publishedAtUtc;
  if (entry.expiredAtUtc !== undefined) out.expiredAtUtc = entry.expiredAtUtc;
  return out;
}

function canonicalEntryJson(entry: PostIndexEntry): string {
  return JSON.stringify(canonicalEntryObject(entry));
}
