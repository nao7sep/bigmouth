import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type { AnthropicSettingsView, Settings, Workspace } from "@shared/types";
const pendingBridge = vi.hoisted(() => ({ listeners: new Set<(pending: boolean) => void>() }));

// First-run setup asks for the workspace, its first target and the optional
// API key, each saved through the ordinary call the moment the user continues.
// The api is mocked so each step's call, and what a skip leaves unwritten, can
// be asserted directly.
vi.mock("@renderer/api", () => ({
  getStoragePending: vi.fn(async () => false),
  onStoragePendingChanged: (listener: (pending: boolean) => void) => {
    pendingBridge.listeners.add(listener);
    return () => pendingBridge.listeners.delete(listener);
  },
  reportProblem: vi.fn(),
  suggestWorkspaceLocation: vi.fn(),
  openOrCreateWorkspace: vi.fn(),
  pickWorkspaceDirectory: vi.fn(),
  listTargets: vi.fn(),
  getSettings: vi.fn(),
  saveTargets: vi.fn(),
  getAnthropicSettings: vi.fn(),
  saveAnthropicSettings: vi.fn(),
}));

import { SetupModal } from "@renderer/components/SetupModal";
import { StoragePendingProvider, StoragePendingResults } from "@renderer/StoragePending";
import {
  getAnthropicSettings,
  getSettings,
  listTargets,
  openOrCreateWorkspace,
  pickWorkspaceDirectory,
  saveAnthropicSettings,
  saveTargets,
  suggestWorkspaceLocation,
} from "@renderer/api";

const mockSuggest = vi.mocked(suggestWorkspaceLocation);
const mockOpenOrCreate = vi.mocked(openOrCreateWorkspace);
const mockPick = vi.mocked(pickWorkspaceDirectory);
const mockListTargets = vi.mocked(listTargets);
const mockGetSettings = vi.mocked(getSettings);
const mockSaveTargets = vi.mocked(saveTargets);
const mockGetAnthropic = vi.mocked(getAnthropicSettings);
const mockSaveAnthropic = vi.mocked(saveAnthropicSettings);
const mockWriteRendererLog = vi.fn();

const WS: Workspace = { id: "ws1", name: "My Blog", dataDirectory: "/home/me/Documents/BigMouth/My Blog" };

const ANTHROPIC: AnthropicSettingsView = {
  endpoint: "https://api.anthropic.com",
  models: { analysis: "a", metadata: "m", imagingPrompts: "i" },
  thinking: { analysis: "adaptive", metadata: "off", imagingPrompts: "adaptive" },
  hasApiKey: false,
  usingEnvKey: false,
  keyNotice: null,
};

beforeEach(() => {
  mockWriteRendererLog.mockReset();
  Object.defineProperty(window, "bigmouth", { configurable: true, value: { writeRendererLog: mockWriteRendererLog } });
  mockSuggest.mockImplementation(async (name?: string) => `/home/me/Documents/BigMouth/${name ?? "Workspace"}`);
  mockOpenOrCreate.mockResolvedValue(WS);
  mockListTargets.mockResolvedValue([]);
  mockGetSettings.mockResolvedValue({ supportedLanguages: ["en", "ja"] } as Settings);
  mockSaveTargets.mockImplementation(async (targets) => targets);
  mockGetAnthropic.mockResolvedValue(ANTHROPIC);
  mockSaveAnthropic.mockImplementation(async (input) => ({ ...ANTHROPIC, ...input, hasApiKey: true }));
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

async function renderDepartableSetup() {
  const onFinish = vi.fn();
  const onOpenExisting = vi.fn();
  const view = render(<StoragePendingProvider>
    <SetupModal onFinish={onFinish} onOpenExisting={onOpenExisting} />
    <StoragePendingResults />
  </StoragePendingProvider>);
  await flush();
  return { ...view, onFinish, onOpenExisting };
}

function announcePending() {
  act(() => { for (const listener of pendingBridge.listeners) listener(true); });
}

describe("SetupModal — pending changes retain their result after leaving", () => {
  it("allows leaving slow creation and does not advance the retired setup on late success", async () => {
    const work = deferred<Workspace>();
    mockOpenOrCreate.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Continue"));
    announcePending();
    await click(view.getByText("Open Existing Workspace"));
    expect(view.onOpenExisting).toHaveBeenCalledTimes(1);
    await act(async () => { work.resolve(WS); });
    expect(view.queryByText("Your first target")).toBeNull();
    expect(view.onFinish).not.toHaveBeenCalled();
  });

  it("retains a departed creation failure in the surviving result owner", async () => {
    const work = deferred<Workspace>();
    mockOpenOrCreate.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Continue"));
    announcePending();
    await click(view.getByText("Open Existing Workspace"));
    await act(async () => { work.reject(new Error("creation failed")); });
    expect(view.getByRole("alert").textContent).toContain("The workspace could not be opened or created.");
    expect(view.getByRole("alert").closest(".app-operational-result")).not.toBeNull();
  });

  it("leaves a slow target save without advancing after its final success", async () => {
    const work = deferred<Awaited<ReturnType<typeof saveTargets>>>();
    mockSaveTargets.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Continue"));
    await click(view.getByText("Continue"));
    announcePending();
    await click(view.getByText("Open Existing Workspace"));
    expect(view.onOpenExisting).toHaveBeenCalledTimes(1);
    await act(async () => { work.resolve([]); });
    expect(view.queryByText("Your API key")).toBeNull();
  });

  it("retains a departed target failure without applying it to a successor", async () => {
    const work = deferred<Awaited<ReturnType<typeof saveTargets>>>();
    mockSaveTargets.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Continue"));
    await click(view.getByText("Continue"));
    announcePending();
    await click(view.getByText("Open Existing Workspace"));
    await act(async () => { work.reject(new Error("target failed")); });
    expect(view.getByRole("alert").closest(".app-operational-result")).not.toBeNull();
    expect(view.getByRole("alert").textContent).toContain("The target could not be saved.");
  });

  it("does not finish retired setup when a slow key save completes", async () => {
    const work = deferred<AnthropicSettingsView>();
    mockSaveAnthropic.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Continue"));
    await click(view.getByText("Continue"));
    fireEvent.change(view.getByLabelText(/^API Key/), { target: { value: "test-key" } });
    await click(view.getByText("Finish"));
    announcePending();
    await click(view.getByText("Open Existing Workspace"));
    await act(async () => { work.resolve(ANTHROPIC); });
    expect(view.onFinish).not.toHaveBeenCalled();
  });

  it("retains the key recovery warning after leaving a slow save", async () => {
    const work = deferred<AnthropicSettingsView>();
    mockSaveAnthropic.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Continue"));
    await click(view.getByText("Continue"));
    fireEvent.change(view.getByLabelText(/^API Key/), { target: { value: "test-key" } });
    await click(view.getByText("Finish"));
    announcePending();
    await click(view.getByText("Open Existing Workspace"));
    await act(async () => { work.resolve({ ...ANTHROPIC, keyNotice: { key: "settings.keyFileMovedAside", values: { path: "/fixture/keys" } } }); });
    expect(view.getByText(/fixture\/keys/).closest(".app-operational-result")).not.toBeNull();
    expect(view.onFinish).not.toHaveBeenCalled();
  });

  it("retains a departed key failure without exposing its diagnostic details", async () => {
    const work = deferred<AnthropicSettingsView>();
    mockSaveAnthropic.mockReturnValue(work.promise);
    const view = await renderDepartableSetup();
    await click(view.getByText("Continue"));
    await click(view.getByText("Continue"));
    fireEvent.change(view.getByLabelText(/^API Key/), { target: { value: "test-key" } });
    await click(view.getByText("Finish"));
    announcePending();
    await click(view.getByText("Open Existing Workspace"));
    await act(async () => { work.reject(new Error("private-key-save-details")); });
    const result = view.getByRole("alert");
    expect(result.closest(".app-operational-result")).not.toBeNull();
    expect(result.textContent).toContain("The API key could not be saved.");
    expect(result.textContent).not.toContain("private-key-save-details");
    expect(view.onFinish).not.toHaveBeenCalled();
  });

  it("does not issue a key write when setup leaves during section preparation", async () => {
    const view = await renderDepartableSetup();
    await click(view.getByText("Continue"));
    await click(view.getByText("Continue"));
    const read = deferred<AnthropicSettingsView>();
    mockGetAnthropic.mockReturnValueOnce(read.promise);
    fireEvent.change(view.getByLabelText(/^API Key/), { target: { value: "test-key" } });
    await click(view.getByText("Finish"));
    view.unmount();
    await act(async () => { read.resolve(ANTHROPIC); });
    expect(mockSaveAnthropic).not.toHaveBeenCalled();
    expect(view.onFinish).not.toHaveBeenCalled();
  });

  it("admits one save per step when Enter is repeated before rerender", async () => {
    const view = await renderDepartableSetup();
    let field = view.getByLabelText("Name");
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await flush();
    expect(mockOpenOrCreate).toHaveBeenCalledTimes(1);
    field = view.getByLabelText("Name");
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await flush();
    expect(mockSaveTargets).toHaveBeenCalledTimes(1);
    field = view.getByLabelText(/^API Key/);
    fireEvent.change(field, { target: { value: "test-key" } });
    act(() => {
      fireEvent.keyDown(field, { key: "Enter" });
      fireEvent.keyDown(field, { key: "Enter" });
    });
    await flush();
    expect(mockSaveAnthropic).toHaveBeenCalledTimes(1);
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
  const onOpenExisting = vi.fn();
  const utils = render(<SetupModal onFinish={onFinish} onOpenExisting={onOpenExisting} />);
  await flush();
  return { onFinish, onOpenExisting, ...utils };
}

async function click(element: HTMLElement) {
  fireEvent.click(element);
  await flush();
}

describe("SetupModal — the workspace step", () => {
  it("suggests a name and shows the folder it would be created in", async () => {
    const { getByLabelText, getByRole } = await renderSetup();

    expect(getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    const name = getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("My Blog");
    expect(document.activeElement).toBe(name);
    expect((getByLabelText("Location") as HTMLInputElement).value).toBe("/home/me/Documents/BigMouth/My Blog");

    // The location follows the name until the user chooses one.
    fireEvent.change(name, { target: { value: "Travel" } });
    await flush();
    expect(mockSuggest).toHaveBeenLastCalledWith("Travel");
    expect((getByLabelText("Location") as HTMLInputElement).value).toBe("/home/me/Documents/BigMouth/Travel");
  });

  it("creates the workspace through openOrCreateWorkspace, asking for the default location", async () => {
    const { getByText, queryByText } = await renderSetup();

    await click(getByText("Continue"));

    // Left untouched, the location is creation's own default, applied when it creates.
    expect(mockOpenOrCreate).toHaveBeenCalledWith("My Blog", undefined);
    expect(getByText("Your first target")).toBeTruthy();
    expect(queryByText("Your workspace")).toBeNull();
  });

  it("creates in a folder chosen with Browse, which the name no longer moves", async () => {
    mockPick.mockResolvedValue("/Volumes/Data/Writing");
    const { getByText, getByLabelText } = await renderSetup();

    await click(getByText("Browse…"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "Writing" } });
    await flush();
    expect((getByLabelText("Location") as HTMLInputElement).value).toBe("/Volumes/Data/Writing");

    await click(getByText("Continue"));
    expect(mockOpenOrCreate).toHaveBeenCalledWith("Writing", "/Volumes/Data/Writing");
  });

  it("keeps the user on the step with the failure in place", async () => {
    mockOpenOrCreate.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH-SETUP-SENTINEL"));
    const { getByText, getByRole, onFinish } = await renderSetup();

    await click(getByText("Continue"));

    const result = getByRole("alert");
    expect(result.textContent).toContain("The workspace could not be opened or created.");
    expect(result.textContent).not.toContain("BIGMOUTH-SETUP-SENTINEL");
    expect(getByText("Your workspace")).toBeTruthy();
    expect(mockSaveTargets).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: setup workspace open or creation failed",
    }));
  });

  it("hands over to the workspace picker to open an existing folder", async () => {
    const { getByText, onOpenExisting } = await renderSetup();

    await click(getByText("Open Existing Workspace"));

    expect(onOpenExisting).toHaveBeenCalledTimes(1);
    expect(mockOpenOrCreate).not.toHaveBeenCalled();
  });

  it("does not let Escape leave the user with no workspace", async () => {
    const { getByText, queryByRole, onFinish, onOpenExisting } = await renderSetup();

    fireEvent.keyDown(document, { key: "Escape" });
    await flush();

    expect(queryByRole("dialog")).toBeTruthy();
    expect(getByText("Your workspace")).toBeTruthy();
    expect(onFinish).not.toHaveBeenCalled();
    expect(onOpenExisting).not.toHaveBeenCalled();
    // A root launch gate offers no dismiss control at all.
    expect(queryByRole("button", { name: "Close" })).toBeNull();
    expect(queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

async function toTargetStep() {
  const utils = await renderSetup();
  await click(utils.getByText("Continue"));
  return utils;
}

describe("SetupModal — the first target", () => {
  it("prefills a target so one click saves it through saveTargets", async () => {
    const { getByText, getByLabelText } = await toTargetStep();

    expect(mockListTargets).toHaveBeenCalledWith("ws1");
    expect(mockGetSettings).toHaveBeenCalledWith("ws1");
    const name = getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Blog");
    expect(document.activeElement).toBe(name);
    expect((getByLabelText("Language") as HTMLSelectElement).value).toBe("en");
    expect((getByLabelText("Requires metadata") as HTMLSelectElement).value).toBe("yes");

    await click(getByText("Continue"));

    expect(mockSaveTargets).toHaveBeenCalledWith(
      [{ name: "Blog", defaultLanguage: "en", requiresMetadata: true }],
      "ws1",
    );
    expect(getByText("Your API key")).toBeTruthy();
  });

  it("adds to the targets of a workspace that already had some, and refuses a name they use", async () => {
    const existing = { name: "Blog", defaultLanguage: "ja", requiresMetadata: false };
    mockListTargets.mockResolvedValue([existing]);
    const { getByText, getByLabelText } = await toTargetStep();

    const name = getByLabelText("Name");
    expect(getByText("This name is already used by another target.")).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect((getByText("Continue") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(name, { target: { value: "X" } });
    fireEvent.change(getByLabelText("Requires metadata"), { target: { value: "no" } });
    await click(getByText("Continue"));

    expect(mockSaveTargets).toHaveBeenCalledWith(
      [existing, { name: "X", defaultLanguage: "en", requiresMetadata: false }],
      "ws1",
    );
  });

  it("keeps the user on the step when the target cannot be saved", async () => {
    mockSaveTargets.mockRejectedValue(new Error("disk full"));
    const { getByText, getByRole, queryByText } = await toTargetStep();

    await click(getByText("Continue"));

    expect(getByRole("alert").textContent).toContain("The target could not be saved.");
    expect(getByText("Your first target")).toBeTruthy();
    expect(queryByText("Your API key")).toBeNull();
  });

  it("offers Retry in place when the workspace's languages cannot be read", async () => {
    mockGetSettings.mockRejectedValueOnce(new Error("unreadable"));
    const { getByText, getByRole, getByLabelText } = await toTargetStep();

    expect(getByRole("alert").textContent).toContain("could not be loaded");
    await click(getByText("Retry"));

    expect((getByLabelText("Name") as HTMLInputElement).value).toBe("Blog");
  });
});

async function toKeyStep() {
  const utils = await toTargetStep();
  await click(utils.getByText("Continue"));
  return utils;
}

describe("SetupModal — the API key", () => {
  it("writes nothing when skipped, and opens the workspace", async () => {
    const { getByText, getByLabelText, onFinish } = await toKeyStep();

    fireEvent.change(getByLabelText(/^API Key/), { target: { value: "sk-typed-then-skipped" } });
    await click(getByText("Skip"));

    expect(mockSaveAnthropic).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledWith(WS);
  });

  it("saves the key into the section as stored, through saveAnthropicSettings", async () => {
    const { getByText, getByLabelText, onFinish } = await toKeyStep();

    expect((getByText("Finish") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(getByLabelText(/^API Key/), { target: { value: "sk-ant-test" } });
    await click(getByText("Finish"));

    expect(mockGetAnthropic).toHaveBeenLastCalledWith("ws1");
    expect(mockSaveAnthropic).toHaveBeenCalledWith(
      { endpoint: ANTHROPIC.endpoint, models: ANTHROPIC.models, thinking: ANTHROPIC.thinking, apiKey: "sk-ant-test" },
      "ws1",
    );
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith(WS);
  });

  it("keeps the user on the step when the key cannot be saved", async () => {
    mockSaveAnthropic.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH-KEY-SENTINEL"));
    const { getByText, getByLabelText, getByRole, onFinish } = await toKeyStep();

    fireEvent.change(getByLabelText(/^API Key/), { target: { value: "sk-ant-test" } });
    await click(getByText("Finish"));

    expect(getByRole("alert").textContent).toContain("The API key could not be saved.");
    expect(getByRole("alert").textContent).not.toContain("BIGMOUTH-KEY-SENTINEL");
    expect(getByText("Your API key")).toBeTruthy();
    expect(onFinish).not.toHaveBeenCalled();
  });
});
