import { afterEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { AssetMeta } from "@shared/types";

// AssetsTab reaches the backend through these four api calls.
vi.mock("@renderer/api", () => ({
  listAssets: vi.fn(),
  uploadAsset: vi.fn(),
  deleteAsset: vi.fn(),
  assetUrl: vi.fn(
    (postId: string, filename: string, workspaceId?: string) =>
      `asset://${workspaceId ?? "ws"}/${postId}/${filename}`
  ),
}));

import { AssetsTab } from "@renderer/components/AssetsTab";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import { listAssets, uploadAsset, deleteAsset } from "@renderer/api";

const mockListAssets = vi.mocked(listAssets);
const mockUploadAsset = vi.mocked(uploadAsset);
const mockDeleteAsset = vi.mocked(deleteAsset);

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
  cleanup();
  mockListAssets.mockReset();
  mockUploadAsset.mockReset();
  mockDeleteAsset.mockReset();
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

function dropzone(container: HTMLElement): HTMLElement {
  return container.querySelector(".assets-dropzone") as HTMLElement;
}

describe("AssetsTab loading", () => {
  it("shows the empty state when there are no assets", async () => {
    mockListAssets.mockResolvedValue([]);
    const { getByText } = await renderTab();
    expect(getByText("No assets yet")).toBeTruthy();
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

    expect(getByText(/Too large \(max 1 MB\): big\.png/)).toBeTruthy();
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });

  it("collects per-file failures into the error banner", async () => {
    mockListAssets.mockResolvedValue([]);
    mockUploadAsset.mockRejectedValue(new Error("server said no"));
    const { container, getByText } = await renderTab();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { files: [makeFile("bad.png")] } });
    });

    expect(getByText(/Failed to upload 1 file\(s\): bad\.png: server said no/)).toBeTruthy();
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
});

describe("AssetsTab drag and drop", () => {
  it("uploads files provided by a drop event", async () => {
    mockListAssets.mockResolvedValueOnce([]).mockResolvedValueOnce([asset()]);
    mockUploadAsset.mockResolvedValue(asset());
    const { container } = await renderTab();
    const zone = dropzone(container);

    // jsdom can't synthesize a native DataTransfer, so the drop's payload is
    // supplied directly on the event; the handler only reads dataTransfer.files.
    const file = makeFile("dropped.png");
    await act(async () => {
      fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    });
    expect(mockUploadAsset).toHaveBeenCalledWith("p1", file, "w1");
  });

  it("toggles the drag-over class on dragover/dragleave", async () => {
    mockListAssets.mockResolvedValue([]);
    const { container } = await renderTab();
    const zone = dropzone(container);

    fireEvent.dragOver(zone);
    expect(zone.classList.contains("drag-over")).toBe(true);
    fireEvent.dragLeave(zone);
    expect(zone.classList.contains("drag-over")).toBe(false);
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
});

describe("AssetsTab error banner", () => {
  it("dismisses the error banner via the close button", async () => {
    mockListAssets.mockRejectedValue(new Error("oops"));
    const { container, getByText } = await renderTab();
    expect(getByText("oops")).toBeTruthy();
    fireEvent.click(container.querySelector(".assets-error-dismiss") as HTMLButtonElement);
    expect(container.querySelector(".assets-error")).toBeNull();
  });
});

describe("AssetsTab read-only", () => {
  it("shows the read-only dropzone label and disables card actions", async () => {
    mockListAssets.mockResolvedValue([asset({ filename: "ro.png" })]);
    const { container, getByText } = await renderTab({ readOnly: true });
    expect(getByText("Assets are read-only.")).toBeTruthy();
    const card = container.querySelector(".asset-card") as HTMLElement;
    const buttons = within(card).getAllByRole("button");
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("ignores a drop while read-only", async () => {
    mockListAssets.mockResolvedValue([]);
    const { container } = await renderTab({ readOnly: true });
    // The drop handler short-circuits via uploadFiles's readOnly guard.
    await act(async () => {
      fireEvent.drop(dropzone(container), { dataTransfer: { files: [makeFile("x.png")] } });
    });
    expect(mockUploadAsset).not.toHaveBeenCalled();
  });
});
