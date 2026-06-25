import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { createRef, forwardRef, useImperativeHandle } from "react";
import type { PostFrontMatter, Target } from "@shared/types";

// RightPane composes five heavy child tabs that each talk to the backend. We
// replace them with trivial stand-ins so the test focuses on RightPane's own
// logic: which tabs are visible, the effective-tab fallback, loading
// placeholders, the locked/readOnly flag, and flushPendingChanges delegation.
//
// MetadataTab needs a forwardRef stand-in so RightPane's imperative handle can
// reach its flushPendingChanges; the spy is captured per-test below.
const metadataFlush = vi.fn(async () => true);

vi.mock("@renderer/components/AnalysisTab", () => ({
  AnalysisTab: (props: Record<string, unknown>) => (
    <div data-testid="analysis-tab">analysis:{String(props.content)}</div>
  ),
}));
vi.mock("@renderer/components/ImagingTab", () => ({
  ImagingTab: (props: Record<string, unknown>) => (
    <div data-testid="imaging-tab">imaging:{String(props.content)}</div>
  ),
}));
vi.mock("@renderer/components/AssetsTab", () => ({
  AssetsTab: (props: Record<string, unknown>) => (
    <div data-testid="assets-tab" data-readonly={String(props.readOnly)}>
      assets
    </div>
  ),
}));
vi.mock("@renderer/components/PreviewTab", () => ({
  PreviewTab: (props: Record<string, unknown>) => (
    <div data-testid="preview-tab">preview:{String(props.content)}</div>
  ),
}));
vi.mock("@renderer/components/MetadataTab", () => ({
  MetadataTab: forwardRef(function MockMetadataTab(
    props: Record<string, unknown>,
    ref: React.Ref<{ flushPendingChanges: () => Promise<boolean> }>
  ) {
    useImperativeHandle(ref, () => ({ flushPendingChanges: metadataFlush }), []);
    return (
      <div data-testid="metadata-tab" data-readonly={String(props.readOnly)}>
        metadata
      </div>
    );
  }),
}));

import { RightPane, type RightPaneHandle, type RightTab } from "@renderer/components/RightPane";

afterEach(() => {
  cleanup();
  metadataFlush.mockClear();
});

function fm(over: Partial<PostFrontMatter> = {}): PostFrontMatter {
  return {
    id: "p1",
    target: "blog",
    status: "draft",
    language: "en",
    createdAtUtc: "2024-01-01T00:00:00.000Z",
    ...over,
  };
}

function target(requiresMetadata: boolean): Target {
  return { name: "blog", defaultLanguage: "en", requiresMetadata };
}

function baseProps() {
  return {
    workspaceId: "w1",
    content: "BODY",
    postId: "p1",
    frontMatter: fm() as PostFrontMatter | null,
    target: target(true) as Target | null,
    extraFieldWatermark: "",
    onPostUpdated: vi.fn(),
    activeTab: "Analysis" as RightTab,
    onTabChange: vi.fn(),
    analysisTrigger: 0,
    analysisPromptsVersion: 0,
    onInsertAtCursor: vi.fn(),
    maxUploadMb: 10,
    loading: false,
  };
}

function renderPane(over: Partial<ReturnType<typeof baseProps>> = {}, ref?: React.Ref<RightPaneHandle>) {
  const props = { ...baseProps(), ...over };
  const utils = render(<RightPane ref={ref} {...props} />);
  return { ...utils, props };
}

describe("RightPane tab visibility", () => {
  it("shows all five tabs when the target requires metadata", () => {
    renderPane({ target: target(true) });
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Analysis", "Imaging", "Assets", "Preview", "Metadata"]);
  });

  it("hides the Metadata tab and its panel when the target does not require metadata", () => {
    renderPane({ target: target(false) });
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).not.toContain("Metadata");
    expect(screen.queryByTestId("metadata-tab")).toBeNull();
  });

  it("hides Metadata when there is no target at all (requiresMetadata defaults false)", () => {
    renderPane({ target: null });
    expect(screen.queryByRole("tab", { name: "Metadata" })).toBeNull();
  });
});

describe("RightPane effective tab", () => {
  it("marks the active tab's button and shows its panel", () => {
    const { container } = renderPane({ activeTab: "Preview" });
    const previewTab = screen.getByRole("tab", { name: "Preview" });
    expect(previewTab.className).toContain("active");
    // The Preview panel is visible; the Analysis panel is hidden via tab-hidden.
    const previewPanel = screen.getByTestId("preview-tab").parentElement!;
    expect(previewPanel.className).not.toContain("tab-hidden");
    const analysisPanel = container.querySelector('[data-testid="analysis-tab"]')!.parentElement!;
    expect(analysisPanel.className).toContain("tab-hidden");
  });

  it("falls back to the first visible tab and notifies when the active tab is not visible", () => {
    const onTabChange = vi.fn();
    // Metadata is the active tab, but the target hides it -> falls back to Analysis.
    renderPane({ target: target(false), activeTab: "Metadata", onTabChange });
    expect(onTabChange).toHaveBeenCalledWith("Analysis");
    expect(screen.getByRole("tab", { name: "Analysis" }).className).toContain("active");
  });

  it("does not re-notify when the active tab is already visible", () => {
    const onTabChange = vi.fn();
    renderPane({ activeTab: "Imaging", onTabChange });
    expect(onTabChange).not.toHaveBeenCalled();
  });
});

describe("RightPane tab switching", () => {
  it("calls onTabChange when a tab button is clicked", () => {
    const onTabChange = vi.fn();
    renderPane({ activeTab: "Analysis", onTabChange });
    fireEvent.click(screen.getByRole("tab", { name: "Imaging" }));
    expect(onTabChange).toHaveBeenCalledWith("Imaging");
  });
});

describe("RightPane loading placeholders", () => {
  it("shows loading placeholders for the content tabs instead of the real children", () => {
    renderPane({ loading: true });
    expect(screen.queryByTestId("analysis-tab")).toBeNull();
    expect(screen.queryByTestId("imaging-tab")).toBeNull();
    expect(screen.queryByTestId("preview-tab")).toBeNull();
    expect(screen.queryByTestId("assets-tab")).toBeNull();
    // Each placeholder carries its own message.
    expect(screen.getByText("Loading metadata…")).toBeTruthy();
    expect(screen.getAllByText("Loading post…").length).toBeGreaterThan(0);
    expect(screen.getByText("Loading assets…")).toBeTruthy();
  });

  it("renders the metadata placeholder when frontMatter is missing even if not loading", () => {
    renderPane({ loading: false, frontMatter: null });
    expect(screen.queryByTestId("metadata-tab")).toBeNull();
    expect(screen.getByText("Loading metadata…")).toBeTruthy();
  });
});

describe("RightPane locked state", () => {
  it("passes readOnly=true to Assets and Metadata for a published post", () => {
    renderPane({ frontMatter: fm({ status: "published" }) });
    expect(screen.getByTestId("assets-tab").getAttribute("data-readonly")).toBe("true");
    expect(screen.getByTestId("metadata-tab").getAttribute("data-readonly")).toBe("true");
  });

  it("passes readOnly=true for an expired post", () => {
    renderPane({ frontMatter: fm({ status: "expired" }) });
    expect(screen.getByTestId("assets-tab").getAttribute("data-readonly")).toBe("true");
  });

  it("passes readOnly=false for a draft post", () => {
    renderPane({ frontMatter: fm({ status: "draft" }) });
    expect(screen.getByTestId("assets-tab").getAttribute("data-readonly")).toBe("false");
  });
});

describe("RightPane child wiring", () => {
  it("threads content down to the child tabs", () => {
    renderPane({ content: "HELLO" });
    expect(screen.getByTestId("analysis-tab").textContent).toBe("analysis:HELLO");
    expect(screen.getByTestId("preview-tab").textContent).toBe("preview:HELLO");
  });
});

describe("RightPane flushPendingChanges handle", () => {
  it("delegates to the Metadata tab's flush when metadata is shown", async () => {
    metadataFlush.mockResolvedValueOnce(false);
    const ref = createRef<RightPaneHandle>();
    renderPane({ target: target(true) }, ref);
    const result = await ref.current!.flushPendingChanges();
    expect(metadataFlush).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it("resolves true when there is no Metadata tab to flush", async () => {
    const ref = createRef<RightPaneHandle>();
    // No metadata tab is mounted, so metadataRef.current is null -> defaults true.
    renderPane({ target: target(false) }, ref);
    const result = await ref.current!.flushPendingChanges();
    expect(metadataFlush).not.toHaveBeenCalled();
    expect(result).toBe(true);
  });
});
