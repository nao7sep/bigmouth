import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type { Workspace } from "@shared/types";

// App is the top-level shell. It only talks to the main process through these
// two api calls; everything else it owns is routing + pane-width bookkeeping.
vi.mock("@renderer/api", () => ({
  listWorkspaces: vi.fn(),
  setActiveWorkspace: vi.fn(),
}));

// The two heavy children are replaced with stand-ins so the tests assert App's
// own routing and the callbacks it threads down — not the children's internals.
// Each stand-in surfaces the props App passes (and, for WorkspaceSession, lets a
// test drive the imperative flush handle App calls before switching workspaces).
const sessionFlush = vi.fn<() => Promise<boolean>>();

vi.mock("@renderer/WorkspaceSession", () => {
  const { forwardRef, useImperativeHandle } = require("react") as typeof import("react");
  return {
    WorkspaceSession: forwardRef(function MockSession(
      props: {
        workspace: Workspace;
        onSwitchWorkspace: () => void;
      },
      ref: React.Ref<{ flushPendingChanges: () => Promise<boolean> }>
    ) {
      useImperativeHandle(ref, () => ({ flushPendingChanges: sessionFlush }), []);
      return (
        <div data-testid="session">
          <span data-testid="session-ws">{props.workspace.id}</span>
          <button data-testid="session-switch" onClick={props.onSwitchWorkspace}>
            switch
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
    activeWorkspaceId: string | null;
    onWorkspaceDeleted: (id: string) => boolean | Promise<boolean>;
    onWorkspaceUpdated: (ws: Workspace) => void;
  }) => (
    <div data-testid="ws-modal" data-dismissable={String(props.dismissable)}>
      <span data-testid="ws-modal-active">{props.activeWorkspaceId ?? "none"}</span>
      <button
        data-testid="ws-modal-select"
        onClick={() => void props.onSelect({ id: "ws2", name: "Beta", dataDirectory: "/d/beta" })}
      >
        select
      </button>
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

import { App } from "@renderer/App";
import { listWorkspaces, setActiveWorkspace } from "@renderer/api";

const mockList = vi.mocked(listWorkspaces);
const mockSetActive = vi.mocked(setActiveWorkspace);

const WS1: Workspace = { id: "ws1", name: "Alpha", dataDirectory: "/d/a" };

// jsdom serves App from an opaque (about:blank) origin, which has no usable
// localStorage; App persists the active workspace id there. A tiny in-memory
// Storage stand-in gives the bootstrap/persist paths a real store to read back.
function createStorageStub(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  };
}

// jsdom has no ResizeObserver; App's pane-measurement effect needs one. A no-op
// stub satisfies the construct/observe/disconnect calls without measuring.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("localStorage", createStorageStub());
  sessionFlush.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mockList.mockReset();
  mockSetActive.mockReset();
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
    // No stored id: listWorkspaces is never consulted; the picker opens directly.
    expect(mockList).not.toHaveBeenCalled();
    expect(getByTestId("ws-modal")).toBeTruthy();
    expect(getByTestId("ws-modal").getAttribute("data-dismissable")).toBe("false");
    expect(queryByTestId("session")).toBeNull();
  });

  it("renders nothing while the stored-workspace check is still in flight", () => {
    // A stored id with a never-resolving listWorkspaces keeps wsChecked false, so
    // App returns null and mounts neither child until the check settles. (No
    // await — we inspect the pre-resolution frame.)
    localStorage.setItem("bm-workspace-id", "ws1");
    mockList.mockReturnValue(new Promise<Workspace[]>(() => {}));
    const { container } = render(<App />);
    expect(container.querySelector('[data-testid="ws-modal"]')).toBeNull();
    expect(container.querySelector('[data-testid="session"]')).toBeNull();
  });
});

describe("App bootstrap — stored workspace", () => {
  it("loads the stored workspace and renders the session", async () => {
    localStorage.setItem("bm-workspace-id", "ws1");
    mockList.mockResolvedValue([WS1]);
    const { getByTestId, queryByTestId } = await renderApp();

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockSetActive).toHaveBeenCalledWith("ws1");
    expect(getByTestId("session-ws").textContent).toBe("ws1");
    // Loaded straight into a session, so the picker is not mounted.
    expect(queryByTestId("ws-modal")).toBeNull();
  });

  it("falls back to the picker and clears storage when the stored id is gone", async () => {
    localStorage.setItem("bm-workspace-id", "missing");
    mockList.mockResolvedValue([WS1]);
    const { getByTestId, queryByTestId } = await renderApp();

    expect(localStorage.getItem("bm-workspace-id")).toBeNull();
    expect(getByTestId("ws-modal")).toBeTruthy();
    expect(queryByTestId("session")).toBeNull();
  });

  it("falls back to the picker and clears storage when the load rejects", async () => {
    localStorage.setItem("bm-workspace-id", "ws1");
    mockList.mockRejectedValue(new Error("disk gone"));
    const { getByTestId } = await renderApp();

    expect(localStorage.getItem("bm-workspace-id")).toBeNull();
    expect(getByTestId("ws-modal")).toBeTruthy();
  });
});

describe("App workspace selection", () => {
  it("activates, persists, and renders the session for the picked workspace", async () => {
    const { getByTestId, queryByTestId } = await renderApp();
    expect(getByTestId("ws-modal")).toBeTruthy();

    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-select"));
      await Promise.resolve();
    });

    expect(mockSetActive).toHaveBeenCalledWith("ws2");
    expect(localStorage.getItem("bm-workspace-id")).toBe("ws2");
    expect(getByTestId("session-ws").textContent).toBe("ws2");
    // No active workspace existed before selecting, so the picker is replaced.
    expect(queryByTestId("ws-modal")).toBeNull();
  });

  it("aborts the switch when the live session refuses to flush", async () => {
    localStorage.setItem("bm-workspace-id", "ws1");
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

    // flush returned false: the original workspace stays active and selected.
    expect(sessionFlush).toHaveBeenCalled();
    expect(localStorage.getItem("bm-workspace-id")).toBe("ws1");
    expect(getByTestId("session-ws").textContent).toBe("ws1");
    expect(queryByTestId("ws-modal")).toBeTruthy();
  });
});

describe("App switch-workspace modal toggling", () => {
  it("opens the dismissable picker on demand and closes it again", async () => {
    localStorage.setItem("bm-workspace-id", "ws1");
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
    localStorage.setItem("bm-workspace-id", "ws1");
    mockList.mockResolvedValue([WS1]);
    const { getByTestId, queryByTestId } = await renderApp();

    fireEvent.click(getByTestId("session-switch")); // open the picker over the session
    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-delete-active"));
      await Promise.resolve();
    });

    expect(sessionFlush).toHaveBeenCalled();
    expect(mockSetActive).toHaveBeenLastCalledWith("");
    expect(localStorage.getItem("bm-workspace-id")).toBeNull();
    expect(queryByTestId("session")).toBeNull();
    // Back to the non-dismissable picker (no active workspace remains).
    expect(getByTestId("ws-modal").getAttribute("data-dismissable")).toBe("false");
  });

  it("leaves the session alone when a non-active workspace is deleted", async () => {
    localStorage.setItem("bm-workspace-id", "ws1");
    mockList.mockResolvedValue([WS1]);
    const { getByTestId } = await renderApp();

    fireEvent.click(getByTestId("session-switch"));
    await act(async () => {
      fireEvent.click(getByTestId("ws-modal-delete-other"));
      await Promise.resolve();
    });

    // The deleted id wasn't the active one, so nothing tears down.
    expect(sessionFlush).not.toHaveBeenCalled();
    expect(getByTestId("session-ws").textContent).toBe("ws1");
    expect(localStorage.getItem("bm-workspace-id")).toBe("ws1");
  });
});

describe("App active-workspace rename", () => {
  it("threads an updated workspace through to the live session", async () => {
    localStorage.setItem("bm-workspace-id", "ws1");
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
  });
});
