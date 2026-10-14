import { describe, expect, it } from "vitest";
import { finalSegment, nameFew, splitPath } from "@renderer/util/shortenedText";

describe("splitPath", () => {
  it.each([
    // POSIX: the head runs through the separator before the last segment.
    ["/Users/me/Documents/BigMouth/Alpha", "/Users/me/Documents/BigMouth/", "Alpha"],
    // Windows, including a drive root and a UNC share.
    ["C:\\Users\\me\\BigMouth\\Alpha", "C:\\Users\\me\\BigMouth\\", "Alpha"],
    ["C:\\Alpha", "C:\\", "Alpha"],
    ["\\\\server\\share\\Alpha", "\\\\server\\share\\", "Alpha"],
    // Either separator in one path.
    ["C:\\Users/me\\Alpha", "C:\\Users/me\\", "Alpha"],
    // A trailing separator stays with the segment it ends.
    ["/data/alpha/", "/data/", "alpha/"],
    ["C:\\data\\alpha\\\\", "C:\\data\\", "alpha\\\\"],
    // One segment under the root.
    ["/alpha", "/", "alpha"],
  ])("splits %s", (path, head, tail) => {
    expect(splitPath(path)).toEqual({ head, tail });
    expect(head + tail).toBe(path);
  });

  it.each(["/", "\\", "C:\\", "//", "alpha", "", "C:"])("keeps %j whole as its tail, with no head", (path) => {
    expect(splitPath(path)).toEqual({ head: "", tail: path });
  });
});

describe("finalSegment", () => {
  it.each([
    ["/d/a/posts/20260101-000000-utc-broken.md", "20260101-000000-utc-broken.md"],
    ["C:\\d\\posts\\post.md", "post.md"],
    ["/data/alpha/", "alpha"],
    ["post.md", "post.md"],
    ["/", "/"],
  ])("names %s by %s", (path, segment) => {
    expect(finalSegment(path)).toBe(segment);
  });
});

describe("nameFew", () => {
  it("names every item when there are three or fewer", () => {
    expect(nameFew(["a", "b", "c"])).toEqual({ named: ["a", "b", "c"], more: 0 });
    expect(nameFew([])).toEqual({ named: [], more: 0 });
  });

  it("names three and counts the rest", () => {
    expect(nameFew(["a", "b", "c", "d", "e"])).toEqual({ named: ["a", "b", "c"], more: 2 });
  });

  it("names and counts a repeated name once", () => {
    expect(nameFew(["a", "a", "b", "c", "c", "d"])).toEqual({ named: ["a", "b", "c"], more: 1 });
  });
});
