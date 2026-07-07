import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

// PreviewTab resolves image references through assetUrl; everything else is pure
// markdown rendering. The real assetUrl returns a custom-protocol URL, which the
// markdown sanitizer (DOMPurify) strips from <img src> because the scheme isn't
// allowlisted — so the mock returns a sanitizer-safe relative URL, letting the
// test assert the rewrite survives all the way to the rendered <img>.
vi.mock("@renderer/api", () => ({
  assetUrl: vi.fn(
    (postId: string, filename: string, workspaceId?: string) =>
      `resolved/${workspaceId ?? "ws"}/${postId}/${encodeURIComponent(filename)}`
  ),
}));

import { PreviewTab } from "@renderer/components/PreviewTab";
import { assetUrl } from "@renderer/api";

const mockAssetUrl = vi.mocked(assetUrl);

afterEach(() => {
  cleanup();
  mockAssetUrl.mockClear();
});

function renderPreview(content: string) {
  return render(<PreviewTab workspaceId="w1" content={content} postId="p1" />);
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
    expect(img?.getAttribute("src")).toBe("resolved/w1/p1/pic.png");
    expect(img?.getAttribute("alt")).toBe("alt text");
  });

  it("leaves a rooted (leading-slash) image path untouched", () => {
    // The rewrite regex excludes filenames whose first char is "/", so a rooted
    // path is passed through verbatim and assetUrl is never called for it.
    const { container } = renderPreview("![rooted](/already/resolved.png)");
    expect(mockAssetUrl).not.toHaveBeenCalled();
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/already/resolved.png");
  });

  it("recomputes the rendered HTML when the content prop changes", () => {
    const { container, rerender } = renderPreview("first body");
    expect(container.querySelector(".preview-content")?.textContent).toContain("first body");
    rerender(<PreviewTab workspaceId="w1" content="second body" postId="p1" />);
    expect(container.querySelector(".preview-content")?.textContent).toContain("second body");
  });
});
