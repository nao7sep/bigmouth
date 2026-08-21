import { DEFAULT_CONTENT_FONT } from "@shared/types";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

// PreviewTab resolves image references through assetUrl; everything else is pure
// markdown rendering. The mock uses the real custom-protocol shape so these
// tests also prove the sanitizer preserves local uploaded images.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  assetUrl: vi.fn(
    (postId: string, filename: string, workspaceId?: string) =>
      `bigmouth-asset://asset/${workspaceId ?? "ws"}/${postId}/${encodeURIComponent(filename)}`
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

    expect(img?.getAttribute("src")).toBe("bigmouth-asset://asset/ws1/p1/photo.png");
    // The title used to be encoded into the filename.
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
