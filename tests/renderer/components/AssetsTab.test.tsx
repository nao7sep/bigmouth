import { afterEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, createEvent, fireEvent, waitFor, within } from "@testing-library/react";
import type { AssetMeta } from "@shared/types";

// AssetsTab reaches the backend through these four api calls.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  listAssets: vi.fn(),
  uploadAsset: vi.fn(),
  deleteAsset: vi.fn(),
  assetUrl: vi.fn(
    (postId: string, filename: string, workspaceId?: string) =>
      `asset://${workspaceId ?? "ws"}/${postId}/${filename}`
  ),
}));

import { AssetsTab } from "@renderer/components/AssetsTab";
import { inspectAssetDragOffer } from "@renderer/util/assetDrop";
import { AssetUploadAdmissionError } from "@renderer/util/assetUpload";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import { listAssets, uploadAsset, deleteAsset, reportProblem } from "@renderer/api";

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

// A File whose byte size we control; jsdom's File reports the real content
// length, so a tiny string keeps every file under the limit by default.
function makeFile(name: string, sizeBytes = 10): File {
  const file = new File(["x".repeat(Math.max(1, sizeBytes))], name);
  // Force an exact size for the limit-check branches.
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
  props: Partial<{ maxUploadMb: number; readOnly: boolean; onInsertAtCursor: (t: string) => void }> = {}
) {
  const onInsertAtCursor = props.onInsertAtCursor ?? vi.fn();
  const utils = render(
    <ConfirmProvider>
      <AssetsTab
        workspaceId="w1"
        postId="p1"
        onInsertAtCursor={onInsertAtCursor}
        maxUploadMb={props.maxUploadMb ?? 5}
        readOnly={props.readOnly ?? false}
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
  it("shows the empty state when there are no assets", async () => {
    mockListAssets.mockResolvedValue([]);
    const { getByText } = await renderTab();
    expect(getByText("No assets yet. Drop files here or use Upload.")).toBeTruthy();
  });

  it("surfaces a load failure in the error banner", async () => {
    mockListAssets.mockRejectedValue(new Error("list failed"));
    const { getByText } = await renderTab();
    expect(getByText("list failed")).toBeTruthy();
  });

  it("renders an image asset with a thumbnail and an exif note", async () => {
    mockListAssets.mockResolvedValue([
      asset({ filename: "photo.jpg", size: 3_000_000, width: 800, height: 600, hasMetadata: true }),
    ]);
    const { container, getByText } = await renderTab();
    const card = container.querySelector(".asset-card") as HTMLElement;
    expect(card.classList.contains("has-exif")).toBe(true);
    expect(card.querySelector("img")?.getAttribute("src")).toBe("asset://w1/p1/photo.jpg");
    expect(getByText(/2\.9 MB/)).toBeTruthy(); // formatBytes MB branch
    expect(getByText(/800.*600/)).toBeTruthy(); // dimensions
    expect(getByText("Has metadata")).toBeTruthy();
  });

  it("renders a non-image asset with an extension icon instead of a thumbnail", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "notes.pdf", size: 500 })]);
    const { container, getByText } = await renderTab();
    const card = container.querySelector(".asset-card") as HTMLElement;
    expect(card.querySelector("img")).toBeNull();
    expect(getByText("PDF")).toBeTruthy(); // file-icon shows uppercase ext
    expect(getByText("500 B")).toBeTruthy(); // formatBytes bytes branch
  });

  it("formats sizes in KB for mid-range files", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "a.png", size: 4096 })]);
    const { getByText } = await renderTab();
    expect(getByText("4.0 KB")).toBeTruthy();
  });
});

describe("AssetsTab upload via file input", () => {
  it("uploads a chosen file then reloads the list", async () => {
    mockListAssets.mockResolvedValueOnce([]).mockResolvedValueOnce([asset()]);
    mockUploadAsset.mockResolvedValue(asset());
    const { container } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const file = makeFile("pic.png");
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(mockUploadAsset).toHaveBeenCalledWith("p1", file, "w1");
    await waitFor(() => expect(container.querySelector(".asset-card")).toBeTruthy());
  });

  it("rejects files over the size limit and uploads nothing", async () => {
    mockListAssets.mockResolvedValue([]);
    const { container, getByText } = await renderTab({ maxUploadMb: 1 });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    // 2 MB > 1 MB limit.
    const big = makeFile("big.png", 2 * 1024 * 1024);
    await act(async () => {
      fireEvent.change(input, { target: { files: [big] } });
    });

    expect(getByText(/big\.png: is larger than 1 MB/)).toBeTruthy();
    expect(container.querySelector(".assets-result--warning")).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });

  it("collects per-file failures into one persistent result", async () => {
    mockListAssets.mockResolvedValue([]);
    mockUploadAsset.mockRejectedValue(new Error("server said no"));
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("bad.png")] } });
    });

    expect(getByText(/1 upload failed: bad\.png: server said no/)).toBeTruthy();
    expect(container.querySelector(".assets-result--error")).toBeTruthy();
    expect(mockReportProblem).toHaveBeenCalledWith(
      "Asset upload failed.",
      expect.any(Error),
      expect.objectContaining({ filename: "bad.png" }),
    );
  });

  it("presents predictable upload admission rejection as a warning without error logging", async () => {
    mockListAssets.mockResolvedValue([]);
    mockUploadAsset.mockRejectedValue(new AssetUploadAdmissionError("Post is locked."));
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("draft.png")] } });
    });

    expect(getByText(/draft\.png: Post is locked/)).toBeTruthy();
    expect(container.querySelector(".assets-result--warning")).toBeTruthy();
    expect(mockReportProblem).not.toHaveBeenCalled();
  });

  it("clears a failed result when a successful batch covers the failed asset", async () => {
    mockListAssets.mockResolvedValue([]);
    mockUploadAsset
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(asset({ filename: "retry.png" }));
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [makeFile("retry.png"), makeFile("also-ready.png")] },
      });
    });
    expect(getByText(/disk unavailable/)).toBeTruthy();

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("retry.png")] } });
    });
    expect(container.querySelector(".assets-result")).toBeNull();
  });

  it("rejects reserved asset names as input warnings before upload", async () => {
    mockListAssets.mockResolvedValue([]);
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("meta.json")] } });
    });

    expect(getByText(/meta\.json: uses a name BigMouth keeps/)).toBeTruthy();
    expect(container.querySelector(".assets-result--warning")).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });

  it("summarizes a partial batch and does not clear it after an unrelated success", async () => {
    mockListAssets.mockResolvedValue([]);
    mockUploadAsset.mockResolvedValue(asset());
    const { container, getByText } = await renderTab({ maxUploadMb: 1 });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, {
        target: { files: [makeFile("ready.png"), makeFile("large.png", 2 * 1024 * 1024)] },
      });
    });
    expect(getByText(/Added 1 asset; 1 item could not be added: large\.png: is larger than 1 MB/)).toBeTruthy();

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("another.png")] } });
    });
    expect(getByText(/large\.png: is larger than 1 MB/)).toBeTruthy();
  });

  it("asks to replace a duplicate filename and uploads when confirmed", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "dup.png" })]);
    mockUploadAsset.mockResolvedValue(asset({ filename: "dup.png" }));
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
    mockListAssets.mockResolvedValue([asset({ filename: "dup.png" })]);
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
    mockListAssets.mockResolvedValue([asset({ filename: "写真.png" })]);
    const { container, getByRole } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("写真.png")] } });
    });

    await waitFor(() => expect(getByRole("button", { name: "Replace" })).toBeTruthy());
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });

  it("rejects a batch whose distinct filenames sanitize to the same stored name", async () => {
    mockListAssets.mockResolvedValue([]);
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

    mockUploadAsset.mockResolvedValue(asset({ filename: "draft_.png" }));
    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("draft?.png")] } });
    });
    expect(getByText(/resolve to the same asset name \(draft_\.png\)/)).toBeTruthy();
  });
});

describe("AssetsTab drag and drop", () => {
  it("uploads files provided by a drop event", async () => {
    mockListAssets.mockResolvedValueOnce([]).mockResolvedValueOnce([asset()]);
    mockUploadAsset.mockResolvedValue(asset());
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

  it("accepts protected Finder delivery without accepting non-file data", async () => {
    mockListAssets.mockResolvedValue([]);
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

  it("rejects an inspectable batch when every file exceeds the upload limit", () => {
    const oversized = new File(["too large"], "oversized.bin");
    expect(inspectAssetDragOffer({
      types: ["Files"],
      items: [{ kind: "file", getAsFile: () => oversized }] as unknown as DataTransferItemList,
      files: [oversized] as unknown as FileList,
    }, oversized.size - 1)).toBe("rejected");
  });

  it("keeps a mixed inspectable batch neutral", () => {
    const ready = makeFile("ready.png", 10);
    const oversized = makeFile("oversized.png", 30);
    expect(inspectAssetDragOffer({
      types: ["Files"],
      items: [] as unknown as DataTransferItemList,
      files: [ready, oversized] as unknown as FileList,
    }, 20)).toBe("delivery-only");
  });

  it("serializes rapid drops through admission, upload, and refresh", async () => {
    mockListAssets.mockResolvedValue([]);
    let releaseFirst: (() => void) | undefined;
    const firstUpload = new Promise<void>((resolve) => { releaseFirst = resolve; });
    mockUploadAsset
      .mockImplementationOnce(async () => {
        await firstUpload;
        return asset({ filename: "first.png" });
      })
      .mockResolvedValueOnce(asset({ filename: "second.png" }));
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
    mockListAssets.mockResolvedValue([]);
    const { container, getByText } = await renderTab();
    const zone = assetCollection(container);
    const droppedText = createEvent.drop(zone, {
      dataTransfer: { files: [], types: ["text/plain"], dropEffect: "none" },
    });

    fireEvent(zone, droppedText);

    expect(droppedText.defaultPrevented).toBe(true);
    expect((droppedText as DragEvent).dataTransfer?.dropEffect).toBe("none");
    expect(getByText("The Assets collection accepts files from Finder or Upload.")).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });
});

describe("AssetsTab delete", () => {
  it("deletes after confirmation and removes the card", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "gone.png" })]);
    mockDeleteAsset.mockResolvedValue(undefined);
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
    mockListAssets.mockResolvedValue([asset({ filename: "stay.png" })]);
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
    await waitFor(() => expect(getByText("delete boom")).toBeTruthy());
  });
});

describe("AssetsTab insert", () => {
  it("inserts image markdown for an image asset", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "photo.png" })]);
    const onInsertAtCursor = vi.fn();
    const { getByTitle } = await renderTab({ onInsertAtCursor });
    fireEvent.click(getByTitle("Insert at cursor"));
    expect(onInsertAtCursor).toHaveBeenCalledWith("![photo.png](photo.png)");
  });

  it("inserts a plain link for a non-image asset", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "doc.pdf" })]);
    const onInsertAtCursor = vi.fn();
    const { getByTitle } = await renderTab({ onInsertAtCursor });
    fireEvent.click(getByTitle("Insert at cursor"));
    expect(onInsertAtCursor).toHaveBeenCalledWith("[doc.pdf](doc.pdf)");
  });

  it("encodes an asset filename that would otherwise break a Markdown destination", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "写真 (1).png" })]);
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
    expect(getByText("oops")).toBeTruthy();
    fireEvent.click(container.querySelector(".assets-result-dismiss") as HTMLButtonElement);
    expect(container.querySelector(".assets-result")).toBeNull();
  });
});

describe("AssetsTab read-only", () => {
  it("disables Upload and card actions", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "ro.png" })]);
    const { container, getByRole } = await renderTab({ readOnly: true });
    expect((getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(true);
    const card = container.querySelector(".asset-card") as HTMLElement;
    const buttons = within(card).getAllByRole("button");
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("explains a committed drop while read-only", async () => {
    mockListAssets.mockResolvedValue([]);
    const { container, getByText } = await renderTab({ readOnly: true });
    await act(async () => {
      fireEvent.drop(assetCollection(container), { dataTransfer: { files: [makeFile("x.png")] } });
    });
    expect(getByText("Assets are read-only.")).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });
});
