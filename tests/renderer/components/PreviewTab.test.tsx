import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

// PreviewTab resolves image references through assetUrl; everything else is pure
// markdown rendering. The real assetUrl returns a custom-protocol URL, which the
// markdown sanitizer (DOMPurify) strips from <img src> because the scheme isn't
// allowlisted — so the mock returns a sanitizer-safe relative URL, letting the
// test assert the rewrite survives all the way to the rendered <img>.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
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
    rerender(<PreviewTab workspaceId="w1" content="second body" postId="p1" contentFont={DEFAULT_CONTENT_FONT} />);
    expect(container.querySelector(".preview-content")?.textContent).toContain("second body");
  });
});

// The rewrite used to exclude only a leading `/` and run to the closing paren,
// so it swallowed the whole rest of the reference: a hosted image, a data: URI
// and an image with a title all became broken asset URLs — in the tab whose
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

    // The mock stands in for the custom-protocol URL (DOMPurify strips the real
    // scheme from an img src), so the assertion is that the rewrite happened.
    expect(img?.getAttribute("src")).toBe("resolved/ws1/p1/photo.png");
    // The title used to be encoded into the filename.
    expect(img?.getAttribute("src")).not.toContain("caption");
    expect(img?.getAttribute("title")).toBe("A caption");
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
