import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { DEFAULT_CONTENT_FONT, type PostFrontMatter } from "@shared/types";
import { RightPane } from "@renderer/components/RightPane";
import type { MetadataTabHandle } from "@renderer/components/MetadataTab";
import { queuePostMetadata } from "@renderer/api";

vi.mock("@renderer/components/AnalysisTab", () => ({ AnalysisTab: () => null }));
vi.mock("@renderer/components/ImagingTab", () => ({ ImagingTab: () => null }));
vi.mock("@renderer/components/AssetsTab", () => ({ AssetsTab: () => null }));
vi.mock("@renderer/components/PreviewTab", () => ({ PreviewTab: () => null }));
const refusedListeners = vi.hoisted(() => new Set<(event: {
  postId: string; edits: Record<string, unknown>; refusal: { key: "metadata.queueFailed" };
}) => void>());

vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  queuePostMetadata: vi.fn(),
  reportMetadataRefusal: vi.fn(),
  onPostMetadataRefused: (listener: (event: { postId: string; edits: Record<string, unknown>; refusal: { key: "metadata.queueFailed" } }) => void) => {
    refusedListeners.add(listener);
    return () => { refusedListeners.delete(listener); };
  },
  generateMetadataField: vi.fn(),
  generateMetadataFields: vi.fn(),
}));

const mockQueue = vi.mocked(queuePostMetadata);
beforeEach(() => { mockQueue.mockReset(); });
afterEach(cleanup);

function mountMetadata() {
  const ref = createRef<MetadataTabHandle>();
  const onTabChange = vi.fn();
  const renderPost = (postId = "p1", requiresMetadata = true, locked = false, workspaceId = "w1") => <RightPane
    ref={ref} workspaceId={workspaceId} postId={postId} content="Body"
    frontMatter={{ id: postId, target: "blog", status: "draft", language: "en", createdAtUtc: "2026-01-01T00:00:00Z", title: "Original", locked } as PostFrontMatter}
    target={{ name: "blog", defaultLanguage: "en", requiresMetadata }}
    extraFieldWatermark="" onMetadataEdited={vi.fn()} activeTab="Metadata" onTabChange={onTabChange}
    analysisTrigger={0} analysisPromptsVersion={0} onInsertAtCursor={vi.fn()} contentFont={DEFAULT_CONTENT_FONT}
  />;
  const view = render(renderPost());
  return { ...view, ref, onTabChange, refresh: (requiresMetadata: boolean, locked = false, postId = "p1", workspaceId = "w1") => view.rerender(renderPost(postId, requiresMetadata, locked, workspaceId)) };
}

describe("RightPane metadata rescue lifetime", () => {
  it("keeps pending and then refused text available after an external target removal and lock", async () => {
    let refuse!: (value: { key: "metadata.queueFailed" }) => void;
    mockQueue.mockReturnValue(new Promise((resolve) => { refuse = resolve; }));
    const view = mountMetadata();
    const title = view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "My rescue text" } });
    view.refresh(false, true);
    expect(view.getByRole("tab", { name: "Metadata" })).toBeTruthy();
    expect(title.value).toBe("My rescue text");
    expect(title.readOnly).toBe(true);
    expect(view.onTabChange).not.toHaveBeenCalled();
    await act(async () => { refuse({ key: "metadata.queueFailed" }); });
    expect(view.getByRole("tab", { name: "Metadata" })).toBeTruthy();
    expect(view.getByRole("textbox", { name: "Title" })).toBe(title);
    expect(title.value).toBe("My rescue text");
    expect((title.closest(".meta-field")!.querySelector(".meta-field-copy") as HTMLButtonElement).disabled).toBe(false);
    let canLeave = true;
    await act(async () => { canLeave = await view.ref.current!.flushPendingChanges(); });
    expect(canLeave).toBe(false);
  });

  it("allows Metadata to hide after the pending edit is admitted", async () => {
    let accept!: (value: null) => void;
    mockQueue.mockReturnValue(new Promise((resolve) => { accept = resolve; }));
    const view = mountMetadata();
    fireEvent.change(view.getByRole("textbox", { name: "Title" }), { target: { value: "Admitted title" } });
    view.refresh(false);
    expect(view.getByRole("tab", { name: "Metadata" })).toBeTruthy();
    await act(async () => { accept(null); });
    expect(view.queryByRole("tab", { name: "Metadata" })).toBeNull();
    expect(view.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(view.onTabChange).toHaveBeenCalledWith("Analysis");
  });

  it("ignores an old admission settlement after navigating away and back to a fresh post mount", async () => {
    const admissions: Array<(value: null) => void> = [];
    mockQueue.mockImplementation(() => new Promise((resolve) => { admissions.push(resolve); }));
    const view = mountMetadata();
    fireEvent.change(view.getByRole("textbox", { name: "Title" }), { target: { value: "First mount" } });
    view.refresh(true, false, "p2");
    view.refresh(true);
    fireEvent.change(view.getByRole("textbox", { name: "Title" }), { target: { value: "New mount rescue" } });
    view.refresh(false);
    await act(async () => { admissions[0]!(null); });
    expect(view.getByRole("tab", { name: "Metadata" })).toBeTruthy();
    expect((view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement).value).toBe("New mount rescue");
    await act(async () => { admissions[1]!(null); });
    expect(view.queryByRole("tab", { name: "Metadata" })).toBeNull();
  });
});

it("restores Metadata and its raw value when held delivery is refused after the tab hides", async () => {
  mockQueue.mockResolvedValue(null);
  const view = mountMetadata();
  const title = view.getByRole("textbox", { name: "Title" }) as HTMLTextAreaElement;
  fireEvent.change(title, { target: { value: " Raw\n  rescue text " } });
  await act(async () => { await Promise.resolve(); });
  view.refresh(false);
  expect(view.queryByRole("tab", { name: "Metadata" })).toBeNull();
  expect(view.queryByRole("textbox", { name: "Title" })).toBeNull();
  expect(title.isConnected).toBe(true);
  expect(title.closest("[hidden]")).toBeTruthy();
  expect(title.closest("[role=tabpanel]")).toBeNull();
  expect(refusedListeners.size).toBe(1);
  act(() => {
    refusedListeners.forEach((listener) => listener({ postId: "p1", edits: { title: "Raw rescue text" }, refusal: { key: "metadata.queueFailed" } }));
  });
  expect(view.getByRole("tab", { name: "Metadata" })).toBeTruthy();
  expect(view.getByRole("textbox", { name: "Title" })).toBe(title);
  expect(title.value).toBe(" Raw\n  rescue text ");
  expect(view.getByRole("alert").textContent).toContain("Metadata could not be saved");
});

it.each(["post", "workspace"])("drops the retained hidden instance when its %s changes", async (change) => {
  mockQueue.mockResolvedValue(null);
  const view = mountMetadata();
  const title = view.getByRole("textbox", { name: "Title" });
  view.refresh(false);
  expect(title.isConnected).toBe(true);
  view.refresh(false, false, change === "post" ? "p2" : "p1", change === "workspace" ? "w2" : "w1");
  expect(title.isConnected).toBe(false);
  expect(refusedListeners.size).toBe(0);
  expect(view.queryByRole("tab", { name: "Metadata" })).toBeNull();
});
