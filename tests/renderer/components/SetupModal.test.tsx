import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type { Settings, Workspace } from "@shared/types";
const pendingBridge = vi.hoisted(() => ({ pending: new Set<string>(), listeners: new Set<(pending: boolean) => void>() }));

// First-run setup comes after the workspace window created the first workspace:
// it asks for that workspace's first target, saved through the ordinary call
// the moment the user finishes, then opens the workspace. The api is mocked so
// the save, and what a skip leaves unwritten, can be asserted directly.
vi.mock("@renderer/api", () => ({
  getStoragePending: vi.fn(async (workspaceId?: string | null) => workspaceId ? pendingBridge.pending.has(workspaceId) : false),
  getDurabilityUnconfirmed: vi.fn().mockResolvedValue(false),
  onDurabilityUnconfirmed: vi.fn(() => () => {}),
  onStoragePendingChanged: (listener: (pending: boolean) => void) => {
    pendingBridge.listeners.add(listener);
    return () => pendingBridge.listeners.delete(listener);
  },
  reportProblem: vi.fn(),
  listTargets: vi.fn(),
  getSettings: vi.fn(),
  saveTargets: vi.fn(),
}));

import { SetupModal } from "@renderer/components/SetupModal";
import { StoragePendingProvider, StoragePendingResults, StoragePendingScope } from "@renderer/StoragePending";
import { getSettings, listTargets, saveTargets } from "@renderer/api";

const mockListTargets = vi.mocked(listTargets);
const mockGetSettings = vi.mocked(getSettings);
const mockSaveTargets = vi.mocked(saveTargets);
const mockWriteRendererLog = vi.fn();

const WS: Workspace = { id: "ws1", name: "My Blog", dataDirectory: "/home/me/Documents/BigMouth/My Blog" };

beforeEach(() => {
  pendingBridge.pending.clear();
  mockWriteRendererLog.mockReset();
  Object.defineProperty(window, "bigmouth", { configurable: true, value: { writeRendererLog: mockWriteRendererLog } });
  mockListTargets.mockResolvedValue([]);
  mockGetSettings.mockResolvedValue({ supportedLanguages: ["en", "ja"] } as Settings);
  mockSaveTargets.mockImplementation(async (targets) => targets);
});

afterEach(() => {
  cleanup();
  pendingBridge.listeners.clear();
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Setup inside the app's result owner, as App renders it. `leave` removes setup
// the way App does once it opens the workspace, keeping the result owner.
async function renderDepartableSetup() {
  const onFinish = vi.fn();
  const tree = (shown: boolean) => (
    <StoragePendingProvider>
      {shown && <StoragePendingScope workspaceId={WS.id}><SetupModal workspace={WS} onFinish={onFinish} /></StoragePendingScope>}
      <StoragePendingResults />
    </StoragePendingProvider>
  );
  const view = render(tree(true));
  await flush();
  return { ...view, onFinish, leave: () => view.rerender(tree(false)) };
}

async function announcePending() {
  await act(async () => {
    pendingBridge.pending.add(WS.id);
    for (const listener of pendingBridge.listeners) listener(true);
  });
}

describe("SetupModal — pending changes retain their result after leaving", () => {
  it("offers Skip only while a slow save is pending, and does not finish twice on its late success", async () => {
    const work = deferred<Awaited<ReturnType<typeof saveTargets>>>();
    mockSaveTargets.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Finish"));
    expect(view.getByRole("button", { name: "Saving…" })).toBeTruthy();
    expect(view.queryByText("Skip")).toBeNull();
    await announcePending();
    await click(view.getByText("Skip"));
    expect(view.onFinish).toHaveBeenCalledExactlyOnceWith(WS);
    await act(async () => { work.resolve([]); });
    expect(view.onFinish).toHaveBeenCalledTimes(1);
  });

  it("retains a departed target failure in the surviving result owner", async () => {
    const work = deferred<Awaited<ReturnType<typeof saveTargets>>>();
    mockSaveTargets.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Finish"));
    await announcePending();
    await click(view.getByText("Skip"));
    view.leave();
    await act(async () => { work.reject(new Error("private target diagnostic")); });
    const result = view.getByRole("alert");
    expect(result.closest(".app-operational-result")).not.toBeNull();
    expect(result.textContent).toContain("The target could not be saved.");
    expect(result.textContent).not.toContain("private target diagnostic");
    expect(view.onFinish).toHaveBeenCalledTimes(1);
  });

  it("does not finish a setup that left before its save succeeded", async () => {
    const work = deferred<Awaited<ReturnType<typeof saveTargets>>>();
    mockSaveTargets.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Finish"));
    view.leave();
    await act(async () => { work.resolve([]); });
    expect(view.onFinish).not.toHaveBeenCalled();
  });

  it("admits one save when Enter is repeated before rerender", async () => {
    const view = await renderDepartableSetup();
    const field = view.getByLabelText("Name");
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await flush();
    expect(mockSaveTargets).toHaveBeenCalledTimes(1);
    expect(view.onFinish).toHaveBeenCalledTimes(1);
  });
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function renderSetup() {
  const onFinish = vi.fn();
  const utils = render(<SetupModal workspace={WS} onFinish={onFinish} />);
  await flush();
  return { onFinish, ...utils };
}

async function click(element: HTMLElement) {
  fireEvent.click(element);
  await flush();
}

describe("SetupModal — the launch gate", () => {
  it("is titled as setup and does not let Escape leave it", async () => {
    const { getByText, getByRole, queryByRole, onFinish } = await renderSetup();

    expect(getByRole("dialog", { name: "Set Up BigMouth" }).getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();

    expect(queryByRole("dialog")).toBeTruthy();
    expect(getByText("Your first target")).toBeTruthy();
    expect(onFinish).not.toHaveBeenCalled();
    // A root launch gate offers no dismiss control at all, and no Skip while
    // the step can be completed.
    expect(queryByRole("button", { name: "Close" })).toBeNull();
    expect(queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(queryByRole("button", { name: "Skip" })).toBeNull();
  });
});

describe("SetupModal — the first target", () => {
  it("prefills a target so one click saves it through saveTargets", async () => {
    const { getByText, getByLabelText, onFinish } = await renderSetup();

    expect(mockListTargets).toHaveBeenCalledWith("ws1");
    expect(mockGetSettings).toHaveBeenCalledWith("ws1");
    const name = getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Blog");
    expect(document.activeElement).toBe(name);
    expect((getByLabelText("Language") as HTMLSelectElement).value).toBe("en");
    expect((getByLabelText("Requires metadata") as HTMLSelectElement).value).toBe("yes");

    await click(getByText("Finish"));

    expect(mockSaveTargets).toHaveBeenCalledWith(
      [{ name: "Blog", defaultLanguage: "en", requiresMetadata: true }],
      "ws1",
    );
    // Saved, so setup finishes by opening the workspace it was given.
    expect(onFinish).toHaveBeenCalledExactlyOnceWith(WS);
  });

  it("adds to the targets of a workspace that already had some, and refuses a name they use", async () => {
    const existing = { name: "Blog", defaultLanguage: "ja", requiresMetadata: false };
    mockListTargets.mockResolvedValue([existing]);
    const { getByText, getByRole, getByLabelText } = await renderSetup();

    const name = getByLabelText("Name");
    expect(getByText("This name is already used by another target.")).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect((getByRole("button", { name: "Finish" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(name, { target: { value: "X" } });
    fireEvent.change(getByLabelText("Requires metadata"), { target: { value: "no" } });
    await click(getByText("Finish"));

    expect(mockSaveTargets).toHaveBeenCalledWith(
      [existing, { name: "X", defaultLanguage: "en", requiresMetadata: false }],
      "ws1",
    );
  });

  it("keeps the user on the step when the target cannot be saved", async () => {
    mockSaveTargets.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH-TARGET-SENTINEL"));
    const { getByText, getByRole, getByLabelText, onFinish } = await renderSetup();

    await click(getByText("Finish"));

    expect(getByRole("alert").textContent).toContain("The target could not be saved.");
    expect(getByRole("alert").textContent).not.toContain("BIGMOUTH-TARGET-SENTINEL");
    expect(getByText("Your first target")).toBeTruthy();
    expect((getByLabelText("Name") as HTMLInputElement).value).toBe("Blog");
    expect(onFinish).not.toHaveBeenCalled();
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: setup target save failed",
    }));
  });

  it("offers Retry in place when the workspace's languages cannot be read", async () => {
    mockGetSettings.mockRejectedValueOnce(new Error("unreadable"));
    const { getByText, getByRole, getByLabelText } = await renderSetup();

    expect(getByRole("alert").textContent).toContain("could not be loaded");
    await click(getByText("Retry"));

    expect((getByLabelText("Name") as HTMLInputElement).value).toBe("Blog");
  });

  it("offers Skip, which opens the workspace without a target, when it has no languages", async () => {
    mockGetSettings.mockResolvedValue({ supportedLanguages: [] as string[] } as Settings);
    const { getByText, queryByText, onFinish } = await renderSetup();

    expect(getByText(/has no supported languages/)).toBeTruthy();
    expect(queryByText("Finish")).toBeNull();
    await click(getByText("Skip"));

    expect(mockSaveTargets).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledExactlyOnceWith(WS);
  });
});
