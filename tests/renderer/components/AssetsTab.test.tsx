import { afterEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, createEvent, fireEvent, waitFor, within } from "@testing-library/react";
import type { AssetMeta } from "@shared/types";

// AssetsTab reaches the backend through these four api calls.
vi.mock("@renderer/api", () => ({
  onWindowActivated: vi.fn(() => () => {}),
  reportProblem: vi.fn(),
  getStoragePending: vi.fn().mockResolvedValue(false),
  onStoragePendingChanged: vi.fn(() => () => {}),
  listAssets: vi.fn(),
  uploadAsset: vi.fn(),
  deleteAsset: vi.fn(),
  assetUrl: vi.fn(
    (postId: string, filename: string, workspaceId?: string) =>
      `asset://${workspaceId ?? "ws"}/${postId}/${filename}`
  ),
  assetDerivativeUrl: vi.fn((kind: string, hash: string) => `asset-${kind}://${hash}`),
}));

import { AssetsTab } from "@renderer/components/AssetsTab";
import { inspectAssetDragOffer } from "@renderer/util/assetDrop";
import { AssetUploadAdmissionError, AssetUploadFailureError } from "@renderer/util/assetUpload";
import { StoragePendingProvider, StoragePendingResults } from "@renderer/StoragePending";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import { onWindowActivated, listAssets, uploadAsset, deleteAsset, reportProblem } from "@renderer/api";
import { usePostAssets } from "@renderer/hooks/usePostAssets";
import { carryingText } from "@shared/i18n/carriedMessage";

const mockListAssets = vi.mocked(listAssets);
const mockUploadAsset = vi.mocked(uploadAsset);
const mockDeleteAsset = vi.mocked(deleteAsset);
const mockReportProblem = vi.mocked(reportProblem);

function asset(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    filename: "pic.png",
    size: 2048,
    uploadedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// A File whose reported byte size we control without allocating it.
function makeFile(name: string, sizeBytes = 10): File {
  const file = new File(["x"], name);
  Object.defineProperty(file, "size", { value: sizeBytes });
  return file;
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  mockListAssets.mockReset();
  mockUploadAsset.mockReset();
  mockDeleteAsset.mockReset();
  mockReportProblem.mockReset();
});

async function renderTab(
  props: Partial<{ locked: boolean; onInsertAtCursor: (t: string) => void }> = {}
) {
  const onInsertAtCursor = props.onInsertAtCursor ?? vi.fn();
  const utils = render(
    <ConfirmProvider>
      <AssetsTab
        workspaceId="w1"
        postId="p1"
        onInsertAtCursor={onInsertAtCursor}
        locked={props.locked ?? false}
      />
    </ConfirmProvider>
  );
  // Flush the initial listAssets load.
  await act(async () => {
    await Promise.resolve();
  });
  return { onInsertAtCursor, ...utils };
}

function assetCollection(container: HTMLElement): HTMLElement {
  return container.querySelector(".assets-tab") as HTMLElement;
}

describe("AssetsTab loading", () => {
  it("keeps pending distinct from empty and shares activation refresh with consumers", async () => {
    vi.useFakeTimers();
    let finish!: (value: { assets: AssetMeta[] }) => void;
    mockListAssets.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const tab = await renderTab();
    expect(tab.getByRole("status").textContent).toBe("Loading…");
    expect(tab.queryByText("No assets yet.")).toBeNull();
    await act(async () => finish({ assets: [asset({ filename: "first.png" })] }));
    function Consumer() {
      const assets = usePostAssets("w1", "p1");
      return <output>{assets?.map(a => a.filename).join(",") ?? "absent"}</output>;
    }
    const consumer = render(<Consumer />);
    expect(consumer.getByText("first.png", { selector: "output" })).toBeTruthy();
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "outside.png" })] });
    const activate = vi.mocked(onWindowActivated).mock.calls.at(-1)![0];
    await act(async () => { activate(); activate(); await vi.advanceTimersByTimeAsync(300); });
    expect(mockListAssets).toHaveBeenCalledTimes(2);
    expect(consumer.getByText("outside.png", { selector: "output" })).toBeTruthy();
    tab.unmount();
    expect(consumer.getByText("outside.png", { selector: "output" })).toBeTruthy();
    consumer.unmount();
    const reopened = render(<Consumer />);
    expect(reopened.getByText("absent")).toBeTruthy();
  });

  it("ignores a departed listing even after the same post is reopened", async () => {
    let finish!: (value: { assets: AssetMeta[] }) => void;
    mockListAssets.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = await renderTab();
    old.unmount();
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "current.png" })] });
    const current = await renderTab();
    await act(async () => finish({ assets: [asset({ filename: "stale.png" })] }));
    expect(current.getByText("current.png")).toBeTruthy();
    expect(current.queryByText("stale.png")).toBeNull();
  });

  it("keeps healthy attachments usable and reports unavailable siblings without claiming an empty folder", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "healthy.png" })], unavailable: ["unreadable.png"] });
    const view = await renderTab();
    expect(view.getByText("healthy.png")).toBeTruthy();
    expect(view.getByText("Some attachments could not be listed: unreadable.png.")).toBeTruthy();
    expect(view.queryByText("No assets yet.")).toBeNull();
  });

  it("does not call a wholly unavailable collection empty", async () => {
    mockListAssets.mockResolvedValue({ assets: [], unavailable: ["unreadable.png"] });
    const view = await renderTab();
    expect(view.getByText("Some attachments could not be listed: unreadable.png.")).toBeTruthy();
    expect(view.queryByText("No assets yet.")).toBeNull();
    fireEvent.click(view.container.querySelector(".assets-result-dismiss")!);
    expect(view.queryByText("Some attachments could not be listed: unreadable.png.")).toBeNull();
    expect(view.queryByText("No assets yet.")).toBeNull();
  });

  it("shows the empty state when there are no assets", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    const { getByText } = await renderTab();
    expect(getByText("No assets yet.")).toBeTruthy();
    expect(getByText("Drop files here or use Add.")).toBeTruthy();
  });

  it("surfaces a load failure in the error banner", async () => {
    mockListAssets.mockRejectedValue(new Error("list failed"));
    const { getByText } = await renderTab();
    expect(getByText("Assets could not be loaded. Reopen this post to try again.")).toBeTruthy();
  });

  it("says where an unreadable meta.json was moved, and keeps saying it through a later upload", async () => {
    const movedAside = {
      path: "/Users/me/Workspace/assets/p1/meta.json",
      movedTo: "/Users/me/Workspace/assets/p1/meta-20261006-031340-123-utc.invalid",
    };
    mockListAssets
      .mockResolvedValueOnce({ assets: [asset({ filename: "a.png", uploadedAt: undefined })], movedAside })
      .mockResolvedValue({ assets: [asset({ filename: "a.png", uploadedAt: undefined }), asset({ filename: "b.png" })] });
    mockUploadAsset.mockResolvedValue({ asset: asset({ filename: "b.png" }) });
    const { container, getByText } = await renderTab();
    const notice = `BigMouth could not read ${movedAside.path} and moved it to ${movedAside.movedTo}. The attached files are listed from the folder, and the upload times and image details that file held are now unknown.`;
    expect(getByText(notice)).toBeTruthy();
    expect(container.querySelector(".assets-result--warning")).toBeTruthy();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("b.png")] } });
    });
    expect(getByText(notice)).toBeTruthy();
  });

  it("renders an image asset with a thumbnail and an exif note", async () => {
    mockListAssets.mockResolvedValue({ assets: [
      asset({ filename: "photo.jpg", size: 3_000_000, width: 800, height: 600, hasMetadata: true }),
    ] });
    const { container, getByText } = await renderTab();
    const card = container.querySelector(".asset-card") as HTMLElement;
    expect(card.className).toBe("asset-card");
    expect(card.querySelector("img")?.getAttribute("src")).toBe("asset://w1/p1/photo.jpg");
    expect(getByText(/2\.9 MB/)).toBeTruthy(); // formatBytes MB branch
    expect(getByText(/800.*600/)).toBeTruthy(); // dimensions
    expect(getByText("Has metadata")).toBeTruthy();
  });

  it("shows a still image through its thumbnail, by its hash, loaded lazily", async () => {
    const hash = "b".repeat(64);
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "photo.jpg", animated: false, contentHash: hash })] });
    const { container } = await renderTab();
    const img = container.querySelector(".asset-card img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(`asset-thumb://${hash}`);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });

  it("shows the file tile when an image's picture cannot be loaded", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "broken.png", animated: false, contentHash: "c".repeat(64) })] });
    const { container, getByText } = await renderTab();
    const img = container.querySelector(".asset-card img") as HTMLImageElement;
    await act(async () => { fireEvent.error(img); });
    expect(container.querySelector(".asset-card img")).toBeNull();
    expect(getByText("PNG")).toBeTruthy();
  });

  it("shows an animated image as itself, streamed and loaded lazily", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "moving.gif", animated: true, contentHash: "d".repeat(64) })] });
    const { container } = await renderTab();
    const img = container.querySelector(".asset-card img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("asset://w1/p1/moving.gif");
    expect(img.getAttribute("loading")).toBe("lazy");
  });

  it("publishes its listing for the Preview, and that it failed", async () => {
    const { usePostAssets } = await import("@renderer/hooks/usePostAssets");
    const seen: unknown[] = [];
    function Probe() {
      seen.push(usePostAssets("w1", "p1"));
      return null;
    }
    render(<Probe />);
    const listed = [asset({ filename: "a.png", contentHash: "e".repeat(64) })];
    mockListAssets.mockResolvedValue({ assets: listed });
    await renderTab();
    expect(seen.at(-1)).toEqual(listed);
    cleanup();
    render(<Probe />);
    mockListAssets.mockRejectedValue(new Error("unreadable"));
    await renderTab();
    expect(seen.at(-1)).toBeNull();
  });

  it("renders a non-image asset with an extension icon instead of a thumbnail", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "notes.pdf", size: 500 })] });
    const { container, getByText } = await renderTab();
    const card = container.querySelector(".asset-card") as HTMLElement;
    expect(card.querySelector("img")).toBeNull();
    expect(getByText("PDF")).toBeTruthy(); // file-icon shows uppercase ext
    expect(getByText("500 byte")).toBeTruthy(); // formatBytes bytes branch, in the locale's unit
  });

  it("formats sizes in KB for mid-range files", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "a.png", size: 4096 })] });
    const { getByText } = await renderTab();
    expect(getByText("4.0 kB")).toBeTruthy();
  });
});

describe("AssetsTab upload via file input", () => {
  it("uploads a chosen file then reloads the list", async () => {
    mockListAssets.mockResolvedValueOnce({ assets: [] }).mockResolvedValueOnce({ assets: [asset()] });
    mockUploadAsset.mockResolvedValue({ asset: asset() });
    const { container } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const file = makeFile("pic.png");
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(mockUploadAsset).toHaveBeenCalledWith("p1", file, "w1");
    await waitFor(() => expect(container.querySelector(".asset-card")).toBeTruthy());
  });

  // Uploads stream, so no size is refused up front.
  it("uploads a file of any size", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockResolvedValue({ asset: asset({ filename: "huge.mov" }) });
    const { container } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const huge = makeFile("huge.mov", 64 * 1024 * 1024 * 1024);
    await act(async () => {
      fireEvent.change(input, { target: { files: [huge] } });
    });

    expect(mockUploadAsset).toHaveBeenCalledWith("p1", huge, "w1");
    expect(container.querySelector(".assets-result")).toBeNull();
  });

  it("names three refused files, counts the rest and lists every reason behind the disclosure", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    const { container } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const files = ["a.tmp", "b.tmp", "c.tmp", "d.tmp", "e.tmp"].map((name) => makeFile(name));
    await act(async () => {
      fireEvent.change(input, { target: { files } });
    });

    const result = container.querySelector(".assets-result--warning") as HTMLElement;
    expect(result.textContent).toContain("5 items could not be added:");
    expect(result.querySelector(".named-items-summary")?.textContent).toBe("a.tmp, b.tmp, c.tmp and 2 more");
    expect([...result.querySelectorAll(".named-items-list li")].map((item) => item.textContent)).toEqual(
      files.map((file) => `${file.name}: It uses a name BigMouth keeps for its own bookkeeping. Rename it and try again.`),
    );
  });

  it("collects per-file failures into one persistent result", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockRejectedValue(new Error("server said no"));
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("bad.png")] } });
    });

    expect(getByText("1 item could not be added:")).toBeTruthy();
    expect(getByText(/^bad\.png: The file could not be added/)).toBeTruthy();
    expect(container.querySelector(".assets-result--error")).toBeTruthy();
    expect(mockReportProblem).toHaveBeenCalledWith(
      "Asset upload failed.",
      expect.any(Error),
      expect.objectContaining({ filename: "bad.png" }),
    );
  });

  it("tells an upload failure that carries its own words in them", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    const metaPath = "/Users/me/Workspace/assets/p1/meta.json";
    mockUploadAsset.mockRejectedValue(
      new Error(carryingText({ key: "store.newerFormat", values: { path: metaPath } })),
    );
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("new.png")] } });
    });

    expect(getByText(`new.png: A newer version of BigMouth saved ${metaPath}, so this version cannot use it. The file was left unchanged; open it with that version.`)).toBeTruthy();
  });

  it.each([
    ["source-unreadable", { key: "assets.sourceUnreadable" }, /^moved\.png: It could not be read\. It may have been moved/],
    ["workspace full", { key: "assets.workspaceFull" }, /^moved\.png: The disk holding the workspace folder is full/],
  ] as const)("tells a %s upload failure as an error, in its own words", async (_label, reason, line) => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockRejectedValue(new AssetUploadFailureError(reason));
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("moved.png")] } });
    });

    expect(getByText(line)).toBeTruthy();
    expect(container.querySelector(".assets-result--error")).toBeTruthy();
  });

  it("presents predictable upload admission rejection as a warning without error logging", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockRejectedValue(new AssetUploadAdmissionError({ key: "assets.admissionLocked" }));
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("draft.png")] } });
    });

    expect(getByText(/^draft\.png: This post is locked/)).toBeTruthy();
    expect(container.querySelector(".assets-result--warning")).toBeTruthy();
    expect(mockReportProblem).not.toHaveBeenCalled();
  });

  it("clears a failed result when a successful batch covers the failed asset", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue({ asset: asset({ filename: "retry.png" }) });
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [makeFile("retry.png"), makeFile("also-ready.png")] },
      });
    });
    expect(getByText(/The file could not be added/)).toBeTruthy();

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("retry.png")] } });
    });
    expect(container.querySelector(".assets-result")).toBeNull();
  });

  it("rejects reserved asset names as input warnings before upload", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("meta.json")] } });
    });

    expect(getByText(/^meta\.json: It uses a name BigMouth keeps/)).toBeTruthy();
    expect(container.querySelector(".assets-result--warning")).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });

  it("summarizes a partial batch and does not clear it after an unrelated success", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockResolvedValue({ asset: asset() });
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [makeFile("ready.png"), makeFile("notes.tmp")] },
      });
    });
    expect(getByText("Added 1 asset.")).toBeTruthy();
    expect(getByText(/^notes\.tmp: It uses a name BigMouth keeps/)).toBeTruthy();

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("another.png")] } });
    });
    expect(getByText(/^notes\.tmp: It uses a name BigMouth keeps/)).toBeTruthy();
  });

  it("asks to replace a duplicate filename and uploads when confirmed", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "dup.png" })] });
    mockUploadAsset.mockResolvedValue({ asset: asset({ filename: "dup.png" }) });
    const { container, getByRole } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("dup.png")] } });
    });

    // The replace dialog appears; confirming proceeds with the upload.
    await waitFor(() => expect(getByRole("button", { name: "Replace" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Replace" }));
    });
    await waitFor(() => expect(mockUploadAsset).toHaveBeenCalledTimes(1));
  });

  it("cancels the upload when the replace dialog is dismissed", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "dup.png" })] });
    const { container, getByRole } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("dup.png")] } });
    });
    await waitFor(() => expect(getByRole("button", { name: "Cancel" })).toBeTruthy());
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Cancel" }));
    });
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });

  it("asks before replacing a Unicode filename using the main-process rules", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "写真.png" })] });
    const { container, getByRole } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("写真.png")] } });
    });

    await waitFor(() => expect(getByRole("button", { name: "Replace" })).toBeTruthy());
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });

  it("rejects a batch whose distinct filenames sanitize to the same stored name", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [makeFile("draft?.png"), makeFile("draft*.png")] },
      });
    });

    expect(getByText(/resolve to the same asset name \(draft_\.png\)/)).toBeTruthy();
    expect(container.querySelector(".assets-result--warning")).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();

    mockUploadAsset.mockResolvedValue({ asset: asset({ filename: "draft_.png" }) });
    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("draft?.png")] } });
    });
    expect(getByText(/resolve to the same asset name \(draft_\.png\)/)).toBeTruthy();
  });
});

describe("AssetsTab drag and drop", () => {
  it("uploads files provided by a drop event", async () => {
    mockListAssets.mockResolvedValueOnce({ assets: [] }).mockResolvedValueOnce({ assets: [asset()] });
    mockUploadAsset.mockResolvedValue({ asset: asset() });
    const { container } = await renderTab();
    const zone = assetCollection(container);

    // jsdom can't synthesize a native DataTransfer, so the drop's payload is
    // supplied directly on the event; the handler only reads dataTransfer.files.
    const file = makeFile("dropped.png");
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file], dropEffect: "none" } });
    });
    expect(mockUploadAsset).toHaveBeenCalledWith("p1", file, "w1");
  });

  it("accepts a drop over a populated asset card through the pane receiver", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "existing.png" })] });
    mockUploadAsset.mockResolvedValue({ asset: asset({ filename: "new.png" }) });
    const { container } = await renderTab();
    const card = container.querySelector(".asset-card") as HTMLElement;
    const file = makeFile("new.png");

    await act(async () => {
      fireEvent.drop(card, { dataTransfer: { files: [file], dropEffect: "none" } });
    });

    expect(mockUploadAsset).toHaveBeenCalledWith("p1", file, "w1");
  });

  it("accepts protected Finder delivery without accepting non-file data", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    const { container } = await renderTab();
    const zone = assetCollection(container);

    const rejected = createEvent.dragOver(zone, {
      dataTransfer: { types: ["text/plain"], dropEffect: "copy" },
    });
    fireEvent(zone, rejected);
    expect(rejected.defaultPrevented).toBe(true);
    expect((rejected as DragEvent).dataTransfer?.dropEffect).toBe("none");
    expect(zone.classList.contains("drag-over")).toBe(false);
    expect(zone.classList.contains("drag-rejected")).toBe(true);

    const deliveryOnly = createEvent.dragOver(zone, {
      dataTransfer: { files: [], types: ["Files"], dropEffect: "copy" },
    });
    fireEvent(zone, deliveryOnly);
    expect(deliveryOnly.defaultPrevented).toBe(true);
    expect((deliveryOnly as DragEvent).dataTransfer?.dropEffect).toBe("copy");
    expect(zone.classList.contains("drag-delivery")).toBe(true);
    expect(zone.classList.contains("drag-over")).toBe(false);
    expect(zone.classList.contains("drag-rejected")).toBe(false);

    const accepted = createEvent.dragOver(zone, {
      dataTransfer: { files: [makeFile("ready.png")], types: ["Files"], dropEffect: "none" },
    });
    fireEvent(zone, accepted);
    expect(accepted.defaultPrevented).toBe(true);
    expect((accepted as DragEvent).dataTransfer?.dropEffect).toBe("copy");
    expect(zone.classList.contains("drag-over")).toBe(true);
    expect(zone.classList.contains("drag-rejected")).toBe(false);
    fireEvent.dragLeave(zone);
    expect(zone.classList.contains("drag-over")).toBe(false);
  });

  it("rejects an inspectable batch when every file uses a reserved name", () => {
    const reserved = new File(["{}"], "meta.json");
    expect(inspectAssetDragOffer({
      types: ["Files"],
      items: [{ kind: "file", getAsFile: () => reserved }] as unknown as DataTransferItemList,
      files: [reserved] as unknown as FileList,
    })).toBe("rejected");
  });

  it("keeps a mixed inspectable batch neutral", () => {
    const ready = makeFile("ready.png", 10);
    const reserved = makeFile("notes.tmp", 30);
    expect(inspectAssetDragOffer({
      types: ["Files"],
      items: [] as unknown as DataTransferItemList,
      files: [ready, reserved] as unknown as FileList,
    })).toBe("delivery-only");
  });

  it("serializes rapid drops through admission, upload, and refresh", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    let releaseFirst: (() => void) | undefined;
    const firstUpload = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mockUploadAsset
      .mockImplementationOnce(async () => {
        await firstUpload;
        return { asset: asset({ filename: "first.png" }) };
      })
      .mockResolvedValueOnce({ asset: asset({ filename: "second.png" }) });
    const { container } = await renderTab();
    const zone = assetCollection(container);

    const firstDrop = createEvent.drop(zone, {
      dataTransfer: {
        files: [makeFile("first.png")],
        types: ["Files"],
        dropEffect: "none",
      },
    });
    const secondDrop = createEvent.drop(zone, {
      dataTransfer: {
        files: [makeFile("second.png")],
        types: ["Files"],
        dropEffect: "none",
      },
    });

    await act(async () => {
      fireEvent(zone, firstDrop);
      fireEvent(zone, secondDrop);
      await Promise.resolve();
    });
    expect(mockUploadAsset).toHaveBeenCalledTimes(1);

    await act(async () => releaseFirst?.());
    await waitFor(() => expect(mockUploadAsset).toHaveBeenCalledTimes(2));
  });

  it("explains a committed drop without local file data", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    const { container, getByText } = await renderTab();
    const zone = assetCollection(container);
    const droppedText = createEvent.drop(zone, {
      dataTransfer: { files: [], types: ["text/plain"], dropEffect: "none" },
    });

    fireEvent(zone, droppedText);

    expect(droppedText.defaultPrevented).toBe(true);
    expect((droppedText as DragEvent).dataTransfer?.dropEffect).toBe("none");
    expect(getByText("The Assets collection accepts files from your file manager or from Add.")).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });
});

describe("AssetsTab delete", () => {
  it("deletes after confirmation and removes the card", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "gone.png" })] });
    mockDeleteAsset.mockResolvedValue({});
    const { container, getByRole, getByTitle } = await renderTab();

    await act(async () => {
      fireEvent.click(getByTitle("Delete"));
    });
    // Scope the confirm click to the dialog — the card also carries a "Delete".
    const dialog = getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });

    expect(mockDeleteAsset).toHaveBeenCalledWith("p1", "gone.png", "w1");
    await waitFor(() => expect(container.querySelector(".asset-card")).toBeNull());
  });

  it("surfaces a delete failure in the error banner", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "stay.png" })] });
    mockDeleteAsset.mockRejectedValue(new Error("delete boom"));
    const { getByRole, getByTitle, getByText } = await renderTab();

    await act(async () => {
      fireEvent.click(getByTitle("Delete"));
    });
    // Both the asset card and the confirm dialog have a "Delete" button, so scope
    // to the dialog before clicking its confirm action.
    const dialog = getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(getByText(
      "stay.png could not be deleted. It remains attached to this post; try again.",
    )).toBeTruthy());
  });
});

describe("AssetsTab asset changes whose record could not be saved", () => {
  it("counts the file as added and says what was not saved", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockResolvedValue({ asset: asset({ filename: "a.png" }), unsaved: ["details", "modifiedTime"] });
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("a.png")] } });
    });

    expect(getByText("Added 1 asset.")).toBeTruthy();
    expect(getByText("a.png was added, but its upload time and image details could not be saved.")).toBeTruthy();
    expect(getByText("a.png was added, but this post's modified time could not be updated.")).toBeTruthy();
    expect(container.querySelector(".assets-result--warning")).toBeTruthy();
  });

  it("removes a deleted file's row and says the post's modified time was not updated", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "gone.png" })] });
    mockDeleteAsset.mockResolvedValue({ unsaved: ["modifiedTime"] });
    const { container, getByRole, getByTitle, getByText } = await renderTab();

    await act(async () => {
      fireEvent.click(getByTitle("Delete"));
    });
    const dialog = getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });

    await waitFor(() => expect(container.querySelector(".asset-card")).toBeNull());
    expect(getByText("gone.png was deleted, but this post's modified time could not be updated.")).toBeTruthy();
  });

  it("lists the attachments again after a failed delete", async () => {
    mockListAssets
      .mockResolvedValueOnce({ assets: [asset({ filename: "gone.png" })] })
      .mockResolvedValue({ assets: [] });
    mockDeleteAsset.mockRejectedValue(new Error("boom"));
    const { container, getByRole, getByTitle } = await renderTab();

    await act(async () => {
      fireEvent.click(getByTitle("Delete"));
    });
    const dialog = getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });

    await waitFor(() => expect(container.querySelector(".asset-card")).toBeNull());
    expect(mockListAssets).toHaveBeenCalledTimes(2);
  });
});

describe("AssetsTab delete failure with its own words", () => {
  it("keeps the delete failure and adds the reason it carries", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "stay.png" })] });
    const metaPath = "/Users/me/Workspace/assets/p1/meta.json";
    mockDeleteAsset.mockRejectedValue(new Error(carryingText({ key: "store.newerFormat", values: { path: metaPath } })));
    const { getByRole, getByTitle, getByText } = await renderTab();

    await act(async () => {
      fireEvent.click(getByTitle("Delete"));
    });
    const dialog = getByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(getByText(
      "stay.png could not be deleted. It remains attached to this post; try again.",
    )).toBeTruthy());
    expect(getByText(`A newer version of BigMouth saved ${metaPath}, so this version cannot use it. The file was left unchanged; open it with that version.`)).toBeTruthy();
  });
});

describe("AssetsTab insert", () => {
  it("inserts image markdown for an image asset", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "photo.png" })] });
    const onInsertAtCursor = vi.fn();
    const { getByTitle } = await renderTab({ onInsertAtCursor });
    fireEvent.click(getByTitle("Insert at cursor"));
    expect(onInsertAtCursor).toHaveBeenCalledWith("![photo.png](photo.png)");
  });

  it("inserts a plain link for a non-image asset", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "doc.pdf" })] });
    const onInsertAtCursor = vi.fn();
    const { getByTitle } = await renderTab({ onInsertAtCursor });
    fireEvent.click(getByTitle("Insert at cursor"));
    expect(onInsertAtCursor).toHaveBeenCalledWith("[doc.pdf](doc.pdf)");
  });

  it("encodes an asset filename that would otherwise break a Markdown destination", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "写真 (1).png" })] });
    const onInsertAtCursor = vi.fn();
    const { getByTitle } = await renderTab({ onInsertAtCursor });
    fireEvent.click(getByTitle("Insert at cursor"));
    expect(onInsertAtCursor).toHaveBeenCalledWith(
      "![写真 (1).png](%E5%86%99%E7%9C%9F%20%281%29.png)",
    );
  });
});

describe("AssetsTab result", () => {
  it("dismisses the result via the close button", async () => {
    mockListAssets.mockRejectedValue(new Error("oops"));
    const { container, getByText } = await renderTab();
    expect(getByText("Assets could not be loaded. Reopen this post to try again.")).toBeTruthy();
    fireEvent.click(container.querySelector(".assets-result-dismiss") as HTMLButtonElement);
    expect(container.querySelector(".assets-result")).toBeNull();
  });
});

// Beside the thumbnail a name gets two lines; hovering shows it whole.
describe("AssetsTab asset names", () => {
  it("keeps the whole name as the name's tooltip", async () => {
    const filename = "a-very-long-asset-name-that-would-run-on-for-several-lines-beside-its-thumbnail.png";
    mockListAssets.mockResolvedValue({ assets: [asset({ filename })] });
    const { container } = await renderTab();
    const name = container.querySelector(".asset-name") as HTMLElement;
    expect(name.textContent).toBe(filename);
    expect(name.getAttribute("title")).toBe(filename);
  });
});

describe("AssetsTab locked", () => {
  it("disables Add and card actions", async () => {
    mockListAssets.mockResolvedValue({ assets: [asset({ filename: "ro.png" })] });
    const { container, getByRole } = await renderTab({ locked: true });
    expect((getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
    const card = container.querySelector(".asset-card") as HTMLElement;
    const buttons = within(card).getAllByRole("button");
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("explains a committed drop while locked", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    const { container, getByText } = await renderTab({ locked: true });
    await act(async () => {
      fireEvent.drop(assetCollection(container), { dataTransfer: { files: [makeFile("x.png")] } });
    });
    expect(getByText("Assets are locked.")).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });
});


it("keeps delayed upload partial-success warnings after leaving Assets", async () => {
  mockListAssets.mockResolvedValue({ assets: [] });
  let finish!: (value: { asset: AssetMeta; unsaved: Array<"details" | "modifiedTime"> }) => void;
  mockUploadAsset.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const surface = (shown: boolean) => <StoragePendingProvider><ConfirmProvider>
    {shown && <AssetsTab workspaceId="w1" postId="p1" onInsertAtCursor={vi.fn()} />}
    <StoragePendingResults />
  </ConfirmProvider></StoragePendingProvider>;
  const view = render(surface(true));
  await act(async () => { await Promise.resolve(); });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [makeFile("pic.png")] } });
  await act(async () => { await Promise.resolve(); });
  view.rerender(surface(false));
  await act(async () => { finish({ asset: asset(), unsaved: ["details", "modifiedTime"] }); });
  expect(view.getAllByRole("status").map((node) => node.textContent).join(" ")).toContain("pic.png");
  // "Added 1 asset." and one result for what could not be saved about it,
  // whose full list keeps both of its lines.
  expect(view.getAllByRole("status")).toHaveLength(2);
  const items = [...view.container.querySelectorAll(".named-items-list li")].map((item) => item.textContent);
  expect(items).toEqual([
    "pic.png was added, but its upload time and image details could not be saved.",
    "pic.png was added, but this post's modified time could not be updated.",
  ]);
});

describe("AssetsTab stalled upload batches", () => {
  it.each(["assets.uploadStalled", "assets.uploadBusy"] as const)("stops after %s and reports every remaining file as not attempted", async (key) => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockResolvedValueOnce({ asset: asset({ filename: "first.png" }) });
    mockUploadAsset.mockRejectedValueOnce(new AssetUploadFailureError({ key }, true));
    const view = await renderTab();
    const files = ["first.png", "stalled.png", "later.png", "last.png"].map(makeFile);
    await act(async () => { fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files } }); });
    expect(mockUploadAsset.mock.calls.map(([, file]) => file.name)).toEqual(["first.png", "stalled.png"]);
    const notice = view.getByRole("alert");
    expect(notice.textContent).toContain("Added 1 asset.");
    expect(notice.textContent).toContain("3 items could not be added:");
    expect(notice.textContent).toContain("later.png: Not attempted while earlier file work is still settling.");
    expect(notice.textContent).toContain("last.png: Not attempted while earlier file work is still settling.");
    expect(notice.textContent).not.toContain("Added 3 assets.");
  });

  it("does not claim any additions when the first file stalls", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockRejectedValueOnce(new AssetUploadFailureError({ key: "assets.uploadStalled" }, true));
    const view = await renderTab();
    await act(async () => { fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [makeFile("stalled.png"), makeFile("later.png")] } }); });
    expect(mockUploadAsset).toHaveBeenCalledOnce();
    expect(view.getByRole("alert").textContent).toContain("2 items could not be added:");
    expect(view.queryByText(/Added [0-9]+ assets?\./)).toBeNull();
  });

  it("continues after an ordinary unreadable source and counts the later addition", async () => {
    mockListAssets.mockResolvedValue({ assets: [] });
    mockUploadAsset.mockRejectedValueOnce(new AssetUploadFailureError({ key: "assets.sourceUnreadable" }));
    mockUploadAsset.mockResolvedValueOnce({ asset: asset({ filename: "readable.png" }) });
    const view = await renderTab();
    await act(async () => { fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [makeFile("unreadable.png"), makeFile("readable.png")] } }); });
    expect(mockUploadAsset.mock.calls.map(([, file]) => file.name)).toEqual(["unreadable.png", "readable.png"]);
    expect(view.getByRole("alert").textContent).toContain("Added 1 asset.");
    expect(view.getByRole("alert").textContent).toContain("1 item could not be added:");
    expect(view.queryByText(/Not attempted while/)).toBeNull();
  });
});
