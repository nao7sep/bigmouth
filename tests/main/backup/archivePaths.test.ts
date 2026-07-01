// The mirror-layout mapping: home files at their relative path, workspaces under workspaces/<id>/.

import { describe, it, expect } from "vitest";
import { forHomeFile, forWorkspaceFile, normalize } from "@main/core/backup/archivePaths.js";

describe("archivePaths", () => {
  it("keeps a home file at its relative path", () => {
    expect(forHomeFile("workspaces.json")).toBe("workspaces.json");
  });

  it("places a workspace file under its id", () => {
    expect(forWorkspaceFile("ws1", "config.json")).toBe("workspaces/ws1/config.json");
    expect(forWorkspaceFile("ws1", "assets/post9/pic.jpg")).toBe("workspaces/ws1/assets/post9/pic.jpg");
  });

  it("normalizes backslashes and a leading slash", () => {
    expect(normalize("a\\b\\c.txt")).toBe("a/b/c.txt");
    expect(normalize("/config.json")).toBe("config.json");
    expect(forWorkspaceFile("ws1", "posts\\p1.md")).toBe("workspaces/ws1/posts/p1.md");
  });
});
