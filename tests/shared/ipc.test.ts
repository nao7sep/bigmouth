// The asset-protocol URL encoding: the one place a post id and a filename become
// a URL the custom scheme can serve.

import { describe, it, expect } from "vitest";
import { assetUrl, ASSET_SCHEME } from "@shared/ipc";

describe("assetUrl", () => {
  it("builds a scheme URL with each id as an encoded path segment under the asset host", () => {
    expect(assetUrl("ws1", "p1", "pic.png")).toBe(`${ASSET_SCHEME}://asset/ws1/p1/pic.png`);
  });

  it("percent-encodes segments so spaces and slashes cannot escape the path", () => {
    const url = assetUrl("w s", "p/1", "a b.png");
    expect(url).toBe(`${ASSET_SCHEME}://asset/w%20s/p%2F1/a%20b.png`);
    // The case-sensitive ids live in the path, not the (lowercased) host.
    expect(url).toContain("://asset/");
  });
});
