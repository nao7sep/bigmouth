import { describe, it, expect } from "vitest";
import {
  draftFilename,
  readyFilename,
  publishedFilename,
  statusSubdir,
} from "./filenames.js";

const ts = new Date("2026-04-05T14:30:22Z");

describe("post filenames", () => {
  it("draft filename is {timestamp}-{nanoid}.md", () => {
    expect(draftFilename(ts, "V1StGXR8_Z5jD")).toBe(
      "20260405-143022-utc-V1StGXR8_Z5jD.md"
    );
  });

  it("ready filename is {timestamp}-{slug}.md", () => {
    expect(readyFilename(ts, "my-first-post")).toBe(
      "20260405-143022-utc-my-first-post.md"
    );
  });

  it("published filename is {timestamp}-{slug}.md", () => {
    expect(publishedFilename(ts, "my-first-post")).toBe(
      "20260405-143022-utc-my-first-post.md"
    );
  });
});

describe("statusSubdir", () => {
  it("maps each status to its directory name", () => {
    expect(statusSubdir("draft")).toBe("drafts");
    expect(statusSubdir("ready")).toBe("ready");
    expect(statusSubdir("published")).toBe("published");
  });
});
