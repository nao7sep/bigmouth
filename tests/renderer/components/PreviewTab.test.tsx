import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, render, cleanup } from "@testing-library/react";

// PreviewTab resolves image references through assetUrl; everything else is pure
// markdown rendering. The mock uses the real custom-protocol shape so these
// tests also prove the sanitizer preserves local uploaded images.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  assetUrl: vi.fn(
    (postId: string, filename: string, workspaceId?: string) =>
      `bigmouth-asset://asset/${workspaceId ?? "ws"}/${postId}/${encodeURIComponent(filename)}`
  ),
  assetDerivativeUrl: vi.fn((kind: string, hash: string) => `bigmouth-asset://${kind}/${hash}`),
}));

import { PreviewTab } from "@renderer/components/PreviewTab";
import { assetUrl } from "@renderer/api";
import { clearPostAssets, publishPostAssets } from "@renderer/hooks/usePostAssets";

const mockAssetUrl = vi.mocked(assetUrl);
const HASH = "a".repeat(64);

// The Assets tab publishes each post's listing; these posts have none attached
// unless a test says otherwise, so a bare filename keeps the original's address.
beforeEach(() => {
  publishPostAssets("w1", "p1", []);
  publishPostAssets("ws1", "p1", []);
});

afterEach(() => {
  cleanup();
  mockAssetUrl.mockClear();
});

function renderPreview(content: string) {
  return render(<PreviewTab workspaceId="w1" content={content} postId="p1" contentFont={DEFAULT_CONTENT_FONT} />);
}

describe("PreviewTab", () => {
  it("shows the empty placeholder when content is blank", () => {
    const { container, getByText } = renderPreview("   \n  ");
    expect(getByText("No content yet")).toBeTruthy();
    expect(container.querySelector(".preview-content")).toBeNull();
    // No content means no image-URL resolution work.
    expect(mockAssetUrl).not.toHaveBeenCalled();
  });

  it("renders markdown into the preview body", () => {
    const { container } = renderPreview("# Heading\n\nsome **bold** text");
    const body = container.querySelector(".preview-content");
    expect(body).toBeTruthy();
    expect(body!.querySelector("h1")?.textContent).toBe("Heading");
    expect(body!.querySelector("strong")?.textContent).toBe("bold");
  });

  it("rewrites a bare image filename through assetUrl", () => {
    const { container } = renderPreview("![alt text](pic.png)");
    expect(mockAssetUrl).toHaveBeenCalledWith("p1", "pic.png", "w1");
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("bigmouth-asset://asset/w1/p1/pic.png");
    expect(img?.getAttribute("alt")).toBe("alt text");
  });

  it("leaves a rooted (leading-slash) image path untouched", () => {
    // Rooted paths are already addressable, so assetUrl is never called for one.
    const { container } = renderPreview("![rooted](/already/resolved.png)");
    expect(mockAssetUrl).not.toHaveBeenCalled();
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/already/resolved.png");
  });

  it("loads every image lazily and decodes it off the main thread", () => {
    const { container } = renderPreview("![a](pic.png)\n\n![b](https://example.com/b.png)");
    const images = [...container.querySelectorAll("img")];
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("decoding")).toBe("async");
    }
  });

  it("shows an attached still image through its display image, by its hash", () => {
    publishPostAssets("w1", "p1", [{ filename: "pic.png", size: 9, animated: false, contentHash: HASH }]);
    const { container } = renderPreview("![alt](pic.png)");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`bigmouth-asset://display/${HASH}`);
  });

  it("keeps an animated image's original, which a display image would stop", () => {
    publishPostAssets("w1", "p1", [
      { filename: "moving.gif", size: 9, animated: true, contentHash: HASH },
      // Recorded before frames were: it may move, so it is shown as itself.
      { filename: "older.webp", size: 9, contentHash: HASH },
    ]);
    const { container } = renderPreview("![a](moving.gif)\n\n![b](older.webp)");
    expect([...container.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "bigmouth-asset://asset/w1/p1/moving.gif",
      "bigmouth-asset://asset/w1/p1/older.webp",
    ]);
  });

  it("gives an attachment no address until the post's assets are listed, then its display image", () => {
    clearPostAssets("w1", "p1");
    const { container } = renderPreview("![alt](pic.png)");
    expect(container.querySelector("img")?.getAttribute("src") ?? "").toBe("");
    act(() => publishPostAssets("w1", "p1", [{ filename: "pic.png", size: 9, animated: false, contentHash: HASH }]));
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`bigmouth-asset://display/${HASH}`);
  });

  it("shows the original when the post's assets could not be listed", () => {
    publishPostAssets("w1", "p1", null);
    const { container } = renderPreview("![alt](pic.png)");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("bigmouth-asset://asset/w1/p1/pic.png");
  });

  it("recomputes the rendered HTML when the content prop changes", () => {
    const { container, rerender } = renderPreview("first body");
    expect(container.querySelector(".preview-content")?.textContent).toContain("first body");
    rerender(<PreviewTab workspaceId="w1" content="second body" postId="p1" contentFont={DEFAULT_CONTENT_FONT} />);
    expect(container.querySelector(".preview-content")?.textContent).toContain("second body");
  });
});

// A rewrite that excluded only a leading `/` and ran to the closing paren would
// swallow the whole rest of the reference: a hosted image, a data: URI and an
// image with a title would all become broken asset URLs — in the tab whose
// entire job is showing what the post will look like.
describe("PreviewTab — image destinations it must not touch", () => {
  function renderWith(content: string) {
    return render(
      <PreviewTab
        workspaceId="ws1"
        content={content}
        postId="p1"
        contentFont={DEFAULT_CONTENT_FONT}
      />,
    );
  }

  it.each([
    ["a hosted image", "https://example.com/x.png"],
    ["a protocol-relative image", "//example.com/x.png"],
    ["a data URI", "data:image/png;base64,AAAA"],
    ["a rooted path", "/img/x.png"],
  ])("leaves %s alone", (_name, dest) => {
    const { container } = renderWith(`![a](${dest})`);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(dest);
  });

  it("rewrites a bare filename and keeps its title", () => {
    const { container } = renderWith('![a](photo.png "A caption")');
    const img = container.querySelector("img");

    expect(img?.getAttribute("src")).toBe("bigmouth-asset://asset/ws1/p1/photo.png");
    // The title stays out of the filename.
    expect(img?.getAttribute("src")).not.toContain("caption");
    expect(img?.getAttribute("title")).toBe("A caption");
  });

  it("resolves an encoded filename with spaces and parentheses", () => {
    const { container } = renderWith("![photo](%E5%86%99%E7%9C%9F%20%281%29.png)");
    expect(mockAssetUrl).toHaveBeenCalledWith("p1", "写真 (1).png", "ws1");
    expect(container.querySelector("img")?.getAttribute("src")).toContain(
      "%E5%86%99%E7%9C%9F%20(1).png",
    );
  });

  it("applies the content font, so reading and writing share a family", () => {
    const { container } = render(
      <PreviewTab
        workspaceId="ws1"
        content="body"
        postId="p1"
        contentFont={{ ...DEFAULT_CONTENT_FONT, family: "Georgia", size: 20 }}
      />,
    );
    const body = container.querySelector(".preview-content") as HTMLElement;

    expect(body.style.fontFamily).toBe("Georgia");
    expect(body.style.fontSize).toBe("20px");
  });
});
