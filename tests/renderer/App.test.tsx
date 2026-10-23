import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { defaultUiState, type UiState, type Workspace } from "@shared/types";
import { message } from "@shared/i18n/translate";

// App is the top-level shell. It talks to the main process through these api
// calls; everything else it owns is routing + pane-width bookkeeping. The view
// state (pane widths + last workspace id) lives in the main process's state.json,
// hydrated via getUiState and persisted via updateUiState.
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  getStoragePending: vi.fn().mockResolvedValue(false),
  getDurabilityUnconfirmed: vi.fn().mockResolvedValue(false),
  onDurabilityUnconfirmed: vi.fn(() => () => {}),
  onStoragePendingChanged: vi.fn(() => () => {}),
  getAppSettings: vi.fn(),
  listWorkspaces: vi.fn(),
  setActiveWorkspace: vi.fn(),
  getUiState: vi.fn(),
  updateUiState: vi.fn(),
}));

// The two heavy children are replaced with stand-ins so the tests assert App's
// own routing and the callbacks it threads down — not the children's internals.
// Each stand-in surfaces the props App passes (and, for WorkspaceSession, lets a
// test drive the imperative flush handle App calls before switching workspaces).
const sessionFlush = vi.fn<() => Promise<boolean>>();

vi.mock("@renderer/WorkspaceSession", async () => {
  const { PaneDivider } = await import("@renderer/components/PaneDivider");
  const { LEFT_MIN, LEFT_MAX, RIGHT_MIN, RIGHT_MAX } = await import("@renderer/paneConstants");
  const { forwardRef, useImperativeHandle } = require("react") as typeof import("react");
  return {
    WorkspaceSession: forwardRef(function MockSession(
      props: {
        workspace: Workspace;
        onSwitchWorkspace: () => void;
        onStartLeftDrag: (event: React.MouseEvent) => void;
        onStartRightDrag: (event: React.MouseEvent) => void;
        leftWidth: number;
        rightWidth: number;
        onLeftWidthChange: (width: number) => void;
        onRightWidthChange: (width: number) => void;
        onLeftWidthCommit: (width: number) => void;
        onRightWidthCommit: (width: number) => void;
        onWorkspaceUpdated: (workspace: Workspace) => void;
      },
      ref: React.Ref<{ flushPendingChanges: () => Promise<boolean> }>
    ) {
      useImperativeHandle(ref, () => ({ flushPendingChanges: sessionFlush }), []);
      return (
        <div data-testid="session">
          <PaneDivider label="Posts divider" width={props.leftWidth} min={LEFT_MIN} max={LEFT_MAX} sign={1}
            onMouseDown={props.onStartLeftDrag} onWidthChange={props.onLeftWidthChange} onCommitWidth={props.onLeftWidthCommit} />
          <PaneDivider label="Tools divider" width={props.rightWidth} min={RIGHT_MIN} max={RIGHT_MAX} sign={-1}
            onMouseDown={props.onStartRightDrag} onWidthChange={props.onRightWidthChange} onCommitWidth={props.onRightWidthCommit} />
          <span data-testid="session-ws">{props.workspace.id}</span>
          <span data-testid="session-ws-name">{props.workspace.name}</span>
          <button
            data-testid="session-rename"
            onClick={() => props.onWorkspaceUpdated({ ...props.workspace, name: "Renamed in Settings" })}
          >
            rename
          </button>
          <button data-testid="session-switch" onClick={props.onSwitchWorkspace}>
            switch
          </button>
          <button data-testid="left-drag" onMouseDown={props.onStartLeftDrag}>
            resize left pane
          </button>
        </div>
      );
    }),
  };
});

vi.mock("@renderer/components/WorkspaceModal", () => ({
  WorkspaceModal: (props: {
    dismissable: boolean;
    onClose: () => void;
    onSelect: (ws: Workspace) => void | Promise<void>;
    onCreated?: (ws: Workspace, firstRun: boolean) => void | Promise<void>;
    activeWorkspaceId: string | null;
    onWorkspaceDeleted: (id: string) => boolean | Promise<boolean>;
    onWorkspaceUpdated: (ws: Workspace) => void;
    onWorkspaceRemovalCompleted: (ws: Workspace, result: { keyCleanupIncomplete?: boolean }) => void;
    onWorkspaceRemovalFailed: (ws: Workspace) => void;
    reloadVersion: number;
    initialLoadError?: { key: string } | null;
  }) => (
    <div data-testid="ws-modal" data-dismissable={String(props.dismissable)} data-load-error={props.initialLoadError?.key ?? ""}>
      <span data-testid="ws-modal-reload">{props.reloadVersion}</span>
      <span data-testid="ws-modal-active">{props.activeWorkspaceId ?? "none"}</span>
      <button
        data-testid="ws-modal-select"
        onClick={() => void props.onSelect({ id: "ws2", name: "Beta", dataDirectory: "/d/beta" })}
      >
        select
      </button>
      <button
        data-testid="ws-modal-created-first"
        onClick={() => void props.onCreated?.({ id: "ws9", name: "My Blog", dataDirectory: "/d/my-blog" }, true)}
      >
        created first
      </button>
      <button
        data-testid="ws-modal-created-later"
        onClick={() => void props.onCreated?.({ id: "ws3", name: "Gamma", dataDirectory: "/d/gamma" }, false)}
      >
        created later
      </button>
      <button data-testid="ws-modal-select-same" onClick={() => void props.onSelect({ id: "ws1", name: "Alpha", dataDirectory: "/d/a" })}>select-same</button>
      <button data-testid="ws-modal-removal-completed" onClick={() => props.onWorkspaceRemovalCompleted({ id: "ws1", name: "Alpha", dataDirectory: "/d/a" }, { keyCleanupIncomplete: true })}>completed</button>
      <button data-testid="ws-modal-removal-failed" onClick={() => void props.onWorkspaceRemovalFailed({ id: "ws1", name: "Alpha", dataDirectory: "/d/a" })}>failed</button>
      <button data-testid="ws-modal-close" onClick={props.onClose}>
        close
      </button>
      <button
        data-testid="ws-modal-delete-active"
        onClick={() => void props.onWorkspaceDeleted("ws1")}
      >
        delete-active
      </button>
      <button
        data-testid="ws-modal-delete-other"
        onClick={() => void props.onWorkspaceDeleted("zzz")}
      >
        delete-other
      </button>
      <button
        data-testid="ws-modal-update"
        onClick={() => props.onWorkspaceUpdated({ id: "ws1", name: "Renamed", dataDirectory: "/d/a" })}
      >
        update
      </button>
    </div>
  ),
}));

// First-run setup is replaced too: App's part is when it shows, for which
// workspace, and that finishing it opens that workspace.
vi.mock("@renderer/components/SetupModal", () => ({
  SetupModal: (props: {
    workspace: Workspace;
    onFinish: (ws: Workspace) => void | Promise<void>;
  }) => (
    <div data-testid="setup">
      <span data-testid="setup-ws">{props.workspace.id}</span>
      <button data-testid="setup-finish" onClick={() => void props.onFinish(props.workspace)}>
        finish
      </button>
    </div>
  ),
}));

import { App as AppContent } from "@renderer/App";
import { StoragePendingProvider } from "@renderer/StoragePending";
// Match production ownership while keeping the heavy confirm child mocked.
function App() { return <StoragePendingProvider><AppContent /></StoragePendingProvider>; }
import { getAppSettings, listWorkspaces, setActiveWorkspace, getUiState, updateUiState } from "@renderer/api";

const mockList = vi.mocked(listWorkspaces);
const mockSetActive = vi.mocked(setActiveWorkspace);
const mockGetUiState = vi.mocked(getUiState);
const mockUpdateUiState = vi.mocked(updateUiState);
const mockGetAppSettings = vi.mocked(getAppSettings);
const mockWriteRendererLog = vi.fn();

const WS1: Workspace = { id: "ws1", name: "Alpha", dataDirectory: "/d/a" };

// Build a UiState with a given remembered workspace id (default pane widths).
function uiState(activeWorkspaceId: string): UiState {
  return { ...defaultUiState(), activeWorkspaceId };
}

// jsdom has no ResizeObserver; App's pane-measurement effect needs one. A no-op
// stub satisfies the construct/observe/disconnect calls without measuring.
beforeEach(() => {
  mockWriteRendererLog.mockReset();
  Object.defineProperty(window, "bigmouth", { configurable: true, value: { writeRendererLog: mockWriteRendererLog } });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  // Default: no remembered workspace. Each test overrides as needed. updateUiState
  // resolves with the merged state so the awaited persist paths settle.
  mockGetUiState.mockResolvedValue(uiState(""));
  // Default: one workspace is registered, so a launch is not a first run.
  mockList.mockResolvedValue([WS1]);
  mockGetAppSettings.mockResolvedValue({ settings: { theme: "system", language: "system" }, notice: null, systemAppearance: "light", systemLanguage: "en" });
  mockUpdateUiState.mockImplementation((patch) => Promise.resolve({ ...uiState(""), ...patch }));
  sessionFlush.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mockList.mockReset();
  mockSetActive.mockReset();
  mockGetUiState.mockReset();
  mockUpdateUiState.mockReset();
});

// Renders App and flushes the bootstrap effect's microtasks so the post-mount
// state (modal vs. session) has settled before assertions.
async function renderApp() {
  const utils = render(<App />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

describe("App bootstrap — no stored workspace", () => {
  it("opens the workspace picker (non-dismissable) when nothing is stored", async () => {
    const { getByTestId, queryByTestId } = await renderApp();
    // No stored id, but workspaces exist: the picker opens on the list.
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(queryByTestId("setup")).toBeNull();
    expect(getByTestId("ws-modal")).toBeTruthy();
    expect(getByTestId("ws-modal").getAttribute("data-dismissable")).toBe("false");
    expect(queryByTestId("session")).toBeNull();
  });

  it("renders nothing while the stored-workspace check is still in flight", () => {
    // A stored id plus a never-resolving listWorkspaces keeps wsChecked false, so
    // App returns null and mounts neither child until the check settles. (No
    // await — we inspect the pre-resolution frame; the async state hydration has
    // not run yet either.)
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockReturnValue(new Promise<Workspace[]>(() => {}));
    const { container } = render(<App />);
    expect(container.querySelector('[data-testid="ws-modal"]')).toBeNull();
    expect(container.querySelector('[data-testid="session"]')).toBeNull();
  });

  it("surfaces a hostile optional UI-state load failure while opening the safe picker", async () => {
    mockGetUiState.mockRejectedValue(
      new Error("EACCES IPC /private/tmp/BIGMOUTH-UI-LOAD-SENTINEL"),
    );
    const { getByTestId, getByRole } = await renderApp();

    expect(getByTestId("ws-modal")).toBeTruthy();
    const result = getByRole("alert");
    expect(result.textContent).toContain("Defaults are in use for this launch");
    expect(result.textContent).not.toContain("BIGMOUTH-UI-LOAD-SENTINEL");
  });
});

describe("App bootstrap — first run", () => {
  // No separate setup gate at launch: with nothing registered, the workspace
  // window is the gate and opens on its new-workspace form.
  it("shows the non-dismissable workspace window, not setup, when no workspace is registered", async () => {
    mockList.mockResolvedValue([]);
    const { getByTestId, queryByTestId } = await renderApp();

    expect(getByTestId("ws-modal").getAttribute("data-dismissable")).toBe("false");
    expect(queryByTestId("setup")).toBeNull();
    expect(queryByTestId("session")).toBeNull();
  });

  it("leaves a stale remembered id alone when nothing is registered, for the first workspace to replace", async () => {
    mockGetUiState.mockResolvedValue(uiState("gone"));
    mockList.mockResolvedValue([]);
    const { getByTestId } = await renderApp();

    expect(getByTestId("ws-modal")).toBeTruthy();
    expect(mockUpdateUiState).not.toHaveBeenCalled();
  });

  it("shows the workspace window when the saved UI state could not be read and nothing is registered", async () => {
    mockGetUiState.mockRejectedValue(new Error("unreadable"));
    mockList.mockResolvedValue([]);
    const { getByTestId, queryByTestId } = await renderApp();

    expect(getByTestId("ws-modal").getAttribute("data-dismissable")).toBe("false");
    expect(queryByTestId("setup")).toBeNull();
  });

  it("continues a first-run creation into setup for that workspace, whose finish opens it", async () => {
    mockList.mockResolvedValue([]);
    const { getByTestId, queryByTestId } = await renderApp();

    act(() => { fireEvent.click(getByTestId("ws-modal-created-first")); });

    expect(getByTestId("setup-ws").textContent).toBe("ws9");
    expect(queryByTestId("ws-modal")).toBeNull();
    expect(queryByTestId("session")).toBeNull();
    expect(mockSetActive).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(getByTestId("setup-finish"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSetActive).toHaveBeenCalledWith("ws9");
    expect(mockUpdateUiState).toHaveBeenCalledWith({ activeWorkspaceId: "ws9" });
    expect(getByTestId("session-ws").textContent).toBe("ws9");
    expect(queryByTestId("setup")).toBeNull();
    expect(queryByTestId("ws-modal")).toBeNull();
  });

  it("opens a workspace created when others exist directly, without setup", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    const { getByTestId, queryByTestId } = await renderApp();

    fireEvent.click(getByTestId("session-switch"));
    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-created-later"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryByTestId("setup")).toBeNull();
    expect(sessionFlush).toHaveBeenCalled();
    expect(mockUpdateUiState).toHaveBeenCalledWith({ activeWorkspaceId: "ws3" });
    expect(getByTestId("session-ws").textContent).toBe("ws3");
    expect(queryByTestId("ws-modal")).toBeNull();
  });

  it("gives the workspace window its recovery copy, not setup, when the registry cannot be read", async () => {
    mockList.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH_FIRST_RUN_SENTINEL"));
    const { getByTestId, queryByTestId } = await renderApp();

    expect(queryByTestId("setup")).toBeNull();
    expect(getByTestId("ws-modal").getAttribute("data-load-error")).toBe("workspaces.loadFailed");
  });
});

describe("App bootstrap — app settings recovery", () => {
  it("names where an unreadable app settings file was moved and what the app started with", async () => {
    mockGetAppSettings.mockResolvedValue({
      settings: { theme: "system", language: "system" },
      notice: message("app.settingsRecovered", { path: "/home/me/.bigmouth/config-20260918-020000-000-utc.invalid" }),
      systemAppearance: "light",
      systemLanguage: "en",
    });
    const { findByText } = await renderApp();

    expect(
      await findByText(/moved to \/home\/me\/\.bigmouth\/config-20260918-020000-000-utc\.invalid.*back to System/),
    ).toBeTruthy();
  });

  it("stays quiet when nothing was reset", async () => {
    const { queryByText } = await renderApp();
    expect(queryByText(/app settings file/)).toBeNull();
  });
});

describe("App bootstrap — stored workspace", () => {
  it("loads the stored workspace and renders the session", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockResolvedValue([WS1]);
    const { getByTestId, queryByTestId } = await renderApp();

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockSetActive).toHaveBeenCalledWith("ws1");
    expect(getByTestId("session-ws").textContent).toBe("ws1");
    // Loaded straight into a session, so the picker is not mounted.
    expect(queryByTestId("ws-modal")).toBeNull();
  });

  it("falls back to the picker and clears the remembered id when the stored id is gone", async () => {
    mockGetUiState.mockResolvedValue(uiState("missing"));
    mockList.mockResolvedValue([WS1]);
    const { getByTestId, queryByTestId } = await renderApp();

    expect(mockUpdateUiState).toHaveBeenCalledWith({ activeWorkspaceId: "" });
    expect(getByTestId("ws-modal")).toBeTruthy();
    expect(queryByTestId("session")).toBeNull();
  });

  it("keeps the remembered id and gives the picker authored recovery copy when loading rejects", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH_SENTINEL"));
    const { getByTestId } = await renderApp();

    expect(mockUpdateUiState).not.toHaveBeenCalledWith({ activeWorkspaceId: "" });
    const modal = getByTestId("ws-modal");
    expect(modal.getAttribute("data-load-error")).toBe("app.workspacesLoadFailed");
    expect(modal.textContent).not.toContain("BIGMOUTH_SENTINEL");
  });
});

describe("App workspace selection", () => {
  it("keeps the opened workspace visible and reports a hostile preference-save failure safely", async () => {
    mockUpdateUiState.mockRejectedValueOnce(new Error("EACCES /private/tmp/BIGMOUTH_UI_STATE_SENTINEL"));
    const { getByTestId, getByRole } = await renderApp();

    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-select"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByTestId("session-ws").textContent).toBe("ws2");
    expect(getByRole("alert").textContent).toContain("could not be remembered")
    expect(getByRole("alert").textContent).not.toContain("BIGMOUTH_UI_STATE_SENTINEL")
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: active workspace preference save failed",
    }));
  });

  it("activates, persists, and renders the session for the picked workspace", async () => {
    const { getByTestId, queryByTestId } = await renderApp();
    expect(getByTestId("ws-modal")).toBeTruthy();

    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-select"));
      await Promise.resolve();
    });

    expect(mockSetActive).toHaveBeenCalledWith("ws2");
    expect(mockUpdateUiState).toHaveBeenCalledWith({ activeWorkspaceId: "ws2" });
    expect(getByTestId("session-ws").textContent).toBe("ws2");
    // No active workspace existed before selecting, so the picker is replaced.
    expect(queryByTestId("ws-modal")).toBeNull();
  });

  it("aborts the switch when the live session refuses to flush", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockResolvedValue([WS1]);
    sessionFlush.mockResolvedValue(false);
    const { getByTestId, queryByTestId } = await renderApp();

    // Open the picker over the live session (dismissable), then pick another ws.
    fireEvent.click(getByTestId("session-switch"));
    expect(getByTestId("ws-modal").getAttribute("data-dismissable")).toBe("true");

    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-select"));
      await Promise.resolve();
    });

    // flush returned false: the original workspace stays active and selected, and
    // the remembered id was never repointed to ws2.
    expect(sessionFlush).toHaveBeenCalled();
    expect(mockUpdateUiState).not.toHaveBeenCalledWith({ activeWorkspaceId: "ws2" });
    expect(getByTestId("session-ws").textContent).toBe("ws1");
    expect(queryByTestId("ws-modal")).toBeTruthy();
  });

  it("says the next launch asks which workspace to open when clearing a removed active preference fails", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockResolvedValue([WS1]);
    mockUpdateUiState.mockRejectedValueOnce(new Error("EACCES /private/tmp/BIGMOUTH_DELETE_SENTINEL"));
    const { getByTestId, getByRole } = await renderApp();

    fireEvent.click(getByTestId("session-switch"));
    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-delete-active"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByTestId("ws-modal").getAttribute("data-dismissable")).toBe("false");
    expect(getByRole("alert").textContent).toContain("At the next launch, BigMouth asks which workspace to open.")
    expect(getByRole("alert").textContent).not.toContain("BIGMOUTH_DELETE_SENTINEL")
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: cleared active workspace preference save failed",
    }));
  });
});

describe("App pane intent persistence", () => {
  it("keeps the resized pane in use and retains an independent authored save result", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockResolvedValue([WS1]);
    mockUpdateUiState.mockRejectedValueOnce(
      new Error("EACCES IPC /private/tmp/BIGMOUTH-PANE-SENTINEL"),
    );
    const { getByTestId, getByRole } = await renderApp();

    fireEvent.mouseDown(getByTestId("left-drag"), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 140 });
    await act(async () => {
      fireEvent.mouseUp(document);
      await Promise.resolve();
    });

    expect(mockUpdateUiState).toHaveBeenCalledWith({ paneLeftWidth: expect.any(Number) });
    const result = getByRole("alert");
    expect(result.textContent).toContain("current width is still in use");
    expect(result.textContent).not.toContain("BIGMOUTH-PANE-SENTINEL");
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: pane width save failed",
    }));
  });
});

describe("App switch-workspace modal toggling", () => {
  it("opens the dismissable picker on demand and closes it again", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockResolvedValue([WS1]);
    const { getByTestId, queryByTestId } = await renderApp();

    expect(queryByTestId("ws-modal")).toBeNull();
    fireEvent.click(getByTestId("session-switch"));
    const modal = getByTestId("ws-modal");
    expect(modal.getAttribute("data-dismissable")).toBe("true");
    expect(getByTestId("ws-modal-active").textContent).toBe("ws1");

    // Closing the dismissable picker leaves the session intact.
    fireEvent.click(getByTestId("ws-modal-close"));
    expect(queryByTestId("ws-modal")).toBeNull();
    expect(getByTestId("session")).toBeTruthy();
  });
});

describe("App active-workspace deletion", () => {
  it("tears down the session and reopens the picker when the active ws is deleted", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockResolvedValue([WS1]);
    const { getByTestId, queryByTestId } = await renderApp();

    fireEvent.click(getByTestId("session-switch")); // open the picker over the session
    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-delete-active"));
      await Promise.resolve();
    });

    expect(sessionFlush).toHaveBeenCalled();
    expect(mockSetActive).toHaveBeenLastCalledWith("");
    expect(mockUpdateUiState).toHaveBeenCalledWith({ activeWorkspaceId: "" });
    expect(queryByTestId("session")).toBeNull();
    // Back to the non-dismissable picker (no active workspace remains).
    expect(getByTestId("ws-modal").getAttribute("data-dismissable")).toBe("false");
  });

  it("leaves the session alone when a non-active workspace is deleted", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockResolvedValue([WS1]);
    const { getByTestId } = await renderApp();

    fireEvent.click(getByTestId("session-switch"));
    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-delete-other"));
      await Promise.resolve();
    });

    // The deleted id wasn't the active one, so nothing tears down and the
    // remembered id is never cleared.
    expect(sessionFlush).not.toHaveBeenCalled();
    expect(getByTestId("session-ws").textContent).toBe("ws1");
    expect(mockUpdateUiState).not.toHaveBeenCalledWith({ activeWorkspaceId: "" });
  });
});

describe("App active-workspace rename", () => {
  it("threads an updated workspace through to the live session", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockList.mockResolvedValue([WS1]);
    const { getByTestId } = await renderApp();

    fireEvent.click(getByTestId("session-switch"));
    // The picker reports the active workspace before the rename.
    expect(getByTestId("ws-modal-active").textContent).toBe("ws1");
    act(() => {
      fireEvent.click(getByTestId("ws-modal-update"));
    });
    // The session still renders the same id (rename keeps identity); the update
    // path ran without tearing anything down.
    expect(getByTestId("session-ws").textContent).toBe("ws1");
    expect(getByTestId("session-ws-name").textContent).toBe("Renamed");
  });

  it("shows a rename saved from Settings on the open workspace", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    const { getByTestId } = await renderApp();

    act(() => { fireEvent.click(getByTestId("session-rename")); });

    expect(getByTestId("session-ws").textContent).toBe("ws1");
    expect(getByTestId("session-ws-name").textContent).toBe("Renamed in Settings");
    expect(sessionFlush).not.toHaveBeenCalled();
  });
});


it("does not close a reopened workspace picker when an older preference save settles", async () => {
  let finish!: (state: UiState) => void;
  mockUpdateUiState.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = await renderApp();
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-select")); });
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { finish(uiState("ws2")); });
  expect(view.getByTestId("ws-modal")).toBeTruthy();
});

it("retains active removal cleanup warnings and reloads the surviving picker", async () => {
  mockGetUiState.mockResolvedValue(uiState("ws1"));
  const view = await renderApp();
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-delete-active")); });
  fireEvent.click(view.getByTestId("ws-modal-removal-completed"));
  expect(view.getByRole("status").textContent).toContain('"Alpha" was removed from the workspace list');
  expect(view.getByTestId("ws-modal-reload").textContent).toBe("1");
});

it("does not restore failed active removal over a newer selected workspace", async () => {
  mockGetUiState.mockResolvedValue(uiState("ws1"));
  const view = await renderApp();
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-delete-active")); });
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-select")); });
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-removal-failed")); });
  expect(view.getByTestId("session-ws").textContent).toBe("ws2");
});


it("retires a workspace reselected while its committed removal was still pending", async () => {
  mockGetUiState.mockResolvedValue(uiState("ws1"));
  const view = await renderApp();
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-delete-active")); });
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-select-same")); });
  expect(view.getByTestId("session-ws").textContent).toBe("ws1");
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-removal-completed")); });
  expect(view.queryByTestId("session")).toBeNull();
  expect(view.getByTestId("ws-modal-active").textContent).toBe("none");
  expect(mockSetActive).toHaveBeenLastCalledWith("");
  expect(mockUpdateUiState).toHaveBeenLastCalledWith({ activeWorkspaceId: "" });
});

it("invalidates a removed workspace selection still awaiting the newer session's flush", async () => {
  mockGetUiState.mockResolvedValue(uiState("ws1"));
  const view = await renderApp();
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-delete-active")); });
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-select")); });
  fireEvent.click(view.getByTestId("session-switch"));
  let flushed!: (value: boolean) => void;
  sessionFlush.mockImplementation(() => new Promise((resolve) => { flushed = resolve; }));
  fireEvent.click(view.getByTestId("ws-modal-select-same"));
  fireEvent.click(view.getByTestId("ws-modal-removal-completed"));
  await act(async () => { flushed(true); });
  expect(view.getByTestId("session-ws").textContent).toBe("ws2");
  expect(view.getByTestId("ws-modal-active").textContent).toBe("ws2");
  expect(mockSetActive).toHaveBeenLastCalledWith("ws2");
});

it("preserves a different workspace selected before removal completion", async () => {
  mockGetUiState.mockResolvedValue(uiState("ws1"));
  const view = await renderApp();
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-delete-active")); });
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-select")); });
  fireEvent.click(view.getByTestId("session-switch"));
  const writes = mockUpdateUiState.mock.calls.length;
  fireEvent.click(view.getByTestId("ws-modal-removal-completed"));
  expect(view.getByTestId("session-ws").textContent).toBe("ws2");
  expect(mockUpdateUiState).toHaveBeenCalledTimes(writes);
});

it("retires removed active A while preserving an in-flight selection of B", async () => {
  mockGetUiState.mockResolvedValue(uiState("ws1"));
  const view = await renderApp();
  fireEvent.click(view.getByTestId("session-switch"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-delete-active")); });
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-select-same")); });
  fireEvent.click(view.getByTestId("session-switch"));
  let flushed!: (value: boolean) => void;
  sessionFlush.mockImplementation(() => new Promise((resolve) => { flushed = resolve; }));
  fireEvent.click(view.getByTestId("ws-modal-select"));
  await act(async () => { fireEvent.click(view.getByTestId("ws-modal-removal-completed")); });
  expect(view.queryByTestId("session")).toBeNull();
  await act(async () => { flushed(true); });
  expect(view.getByTestId("session-ws").textContent).toBe("ws2");
  expect(mockUpdateUiState).toHaveBeenLastCalledWith({ activeWorkspaceId: "ws2" });
});

describe("App keyboard pane widths", () => {
  it.each(["Posts divider", "Tools divider"])("updates %s live and persists once across release and blur", async (name) => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    const view = await renderApp();
    const divider = view.getByRole("separator", { name });
    const start = Number(divider.getAttribute("aria-valuenow"));
    const delta = name === "Posts divider" ? 16 : -16;
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    fireEvent.keyDown(divider, { key: "ArrowRight", repeat: true });
    expect(Number(divider.getAttribute("aria-valuenow"))).toBe(start + 2 * delta);
    expect(mockUpdateUiState).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyUp(divider, { key: "ArrowRight" }); });
    fireEvent.blur(divider);
    expect(mockUpdateUiState).toHaveBeenCalledExactlyOnceWith({ [name === "Posts divider" ? "paneLeftWidth" : "paneRightWidth"]: start + 2 * delta });
  });

  it("routes keyboard save failure through the shell result without reverting width", async () => {
    mockGetUiState.mockResolvedValue(uiState("ws1"));
    mockUpdateUiState.mockRejectedValueOnce(new Error("EACCES /private/tmp/KEY-PANE-SENTINEL"));
    const view = await renderApp();
    const divider = view.getByRole("separator", { name: "Posts divider" });
    const start = Number(divider.getAttribute("aria-valuenow"));
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    await act(async () => { fireEvent.blur(divider); });
    expect(Number(divider.getAttribute("aria-valuenow"))).toBe(start + 16);
    expect(view.getByRole("alert").textContent).toContain("current width is still in use");
    expect(view.getByRole("alert").textContent).not.toContain("KEY-PANE-SENTINEL");
  });
});
