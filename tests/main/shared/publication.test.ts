import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const backup = vi.hoisted(() => vi.fn());
vi.mock("@main/core/services/backupStore.js", () => ({ record: backup }));
let dir: string;
beforeEach(() => { vi.resetModules(); backup.mockClear(); dir = fs.mkdtempSync(path.join(os.tmpdir(), "bigmouth-publication-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("publication barriers", () => {
  it("flushes complete bytes and final permissions before rename, then the directory", async () => {
    const { writeManagedText } = await import("@main/core/shared/atomicWrite.js");
    const target = path.join(dir, "post.md");
    fs.writeFileSync(target, "before", { mode: 0o640 });
    const events: string[] = [];
    const rename = fs.renameSync;
    const open = fs.openSync;
    const close = fs.closeSync;
    const directoryHandle = -123;
    // Model a destination supporting directory barriers on every test host.
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => file === dir ? directoryHandle : open(file, flags, mode));
    vi.spyOn(fs, "closeSync").mockImplementation(fd => { if (fd !== directoryHandle) close(fd); });
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fd === directoryHandle) events.push("directory");
      else {
        expect(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.endsWith(".tmp"))!), "utf8")).toBe("after");
        if (process.platform !== "win32") expect(fs.fstatSync(fd).mode & 0o777).toBe(0o640);
        events.push("bytes");
      }
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => { events.push("rename"); rename(from, to); });
    writeManagedText(target, "after");
    expect(events).toEqual(["bytes", "rename", "directory"]);
    expect(backup).toHaveBeenCalledWith(target, Buffer.from("after"));
  });

  it("preserves the old file and removes its stage when a pre-publication barrier fails", async () => {
    const { writeManagedText } = await import("@main/core/shared/atomicWrite.js");
    const target = path.join(dir, "post.md");
    fs.writeFileSync(target, "before");
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("disk failed"), { code: "EIO" }); });
    expect(() => writeManagedText(target, "after")).toThrow("disk failed");
    expect(fs.readFileSync(target, "utf8")).toBe("before");
    expect(fs.readdirSync(dir)).toEqual(["post.md"]);
    expect(backup).not.toHaveBeenCalled();
  });

  it.each(["unsupported file barrier", "failed directory barrier"])("keeps publication and backup eligibility after %s", async (failure) => {
    const { writeManagedText } = await import("@main/core/shared/atomicWrite.js");
    const publication = await import("@main/core/shared/publication.js");
    const notice = vi.fn();
    publication.onDurabilityUnconfirmed(notice);
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (failure === "unsupported file barrier" && !fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      if (failure === "failed directory barrier" && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("disk failed"), { code: "EIO" });
    });
    const target = path.join(dir, "post.md");
    expect(() => writeManagedText(target, "after")).not.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("after");
    expect(backup).toHaveBeenCalledTimes(1);
    expect(publication.durabilityUnconfirmed()).toBe(true);
    expect(notice).toHaveBeenCalledWith(target);
    writeManagedText(target, "after");
    expect(backup).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledTimes(1);
    const later = vi.fn();
    publication.onDurabilityUnconfirmed(later);
    expect(later).toHaveBeenCalledWith(target);
  });

  it("flushes every newly created ancestor entry and leaves existing trees untouched", async () => {
    const { createDirectory } = await import("@main/core/shared/publication.js");
    const opened: string[] = [];
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => { opened.push(String(file)); return open(file, flags, mode); });
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {});
    const nested = path.join(dir, "new", "assets");
    createDirectory(nested);
    expect(opened).toEqual([nested, path.dirname(nested), dir]);
    opened.length = 0;
    createDirectory(nested);
    expect(opened).toEqual([]);
  });

  it("flushes both names changed by a move without throwing after publication", async () => {
    const { confirmPublication, durabilityUnconfirmed } = await import("@main/core/shared/publication.js");
    const from = path.join(dir, "staging");
    const to = path.join(dir, "assets");
    fs.mkdirSync(from); fs.mkdirSync(to);
    const opened: string[] = [];
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => { opened.push(String(file)); if (file === from) throw new Error("source unavailable"); return open(file, flags, mode); });
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {});
    expect(() => confirmPublication(path.join(to, "file"), true, from)).not.toThrow();
    expect(opened).toEqual([to, from]);
    expect(durabilityUnconfirmed()).toBe(true);
  });
});
