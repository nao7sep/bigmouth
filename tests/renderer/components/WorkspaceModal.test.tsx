import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Workspace } from "@shared/types";

// WorkspaceModal talks to the main process through these api calls (the list is
// a listbox, so pickWorkspaceDirectory backs the Browse button too).
vi.mock("@renderer/api", () => ({
  listWorkspaces: vi.fn(),
  openOrCreateWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  pickWorkspaceDirectory: vi.fn(),
}));

import { WorkspaceModal } from "@renderer/components/WorkspaceModal";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import {
  listWorkspaces,
  openOrCreateWorkspace,
  updateWorkspace,
  deleteWorkspace,
  pickWorkspaceDirectory,
} from "@renderer/api";

const mockListWorkspaces = vi.mocked(listWorkspaces);
const mockOpenOrCreate = vi.mocked(openOrCreateWorkspace);
const mockUpdateWorkspace = vi.mocked(updateWorkspace);
const mockDeleteWorkspace = vi.mocked(deleteWorkspace);
const mockPickDirectory = vi.mocked(pickWorkspaceDirectory);

const WORKSPACE: Workspace = { id: "ws1", name: "Alpha", dataDirectory: "/data/alpha" };

// jsdom has no layout: the workspace listbox scrolls the active row into view,
// so stub scrollIntoView so arrowing/loading never throws.
beforeEach(() => {
  if (!("scrollIntoView" in HTMLElement.prototype)) {
    (HTMLElement.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
  }
});

async function renderModal() {
  const onClose = vi.fn();
  // Confirms now route through the app-wide host, so the modal needs a
  // ConfirmProvider in scope to call useConfirm.
  const utils = render(
    <ConfirmProvider>
      <WorkspaceModal
        dismissable
        onClose={onClose}
        onSelect={vi.fn()}
        activeWorkspaceId={WORKSPACE.id}
        onWorkspaceDeleted={vi.fn()}
        onWorkspaceUpdated={vi.fn()}
      />
    </ConfirmProvider>
  );
  // Flush the workspace load so the list (and its Rename button) renders.
  await act(async () => {
    await Promise.resolve();
  });
  return { onClose, ...utils };
}

// A flexible variant that lets each test vary the callbacks under assertion.
interface ModalOverrides {
  dismissable?: boolean;
  onClose?: () => void;
  onSelect?: (ws: Workspace) => void | Promise<void>;
  activeWorkspaceId?: string | null;
  onWorkspaceDeleted?: (id: string) => boolean | Promise<boolean>;
  onWorkspaceUpdated?: (ws: Workspace) => void;
}

async function renderWith(over: ModalOverrides = {}) {
  const onClose = over.onClose ?? vi.fn();
  const onSelect = over.onSelect ?? vi.fn();
  const onWorkspaceDeleted = over.onWorkspaceDeleted ?? vi.fn().mockResolvedValue(true);
  const onWorkspaceUpdated = over.onWorkspaceUpdated ?? vi.fn();
  const utils = render(
    <ConfirmProvider>
      <WorkspaceModal
        dismissable={over.dismissable ?? true}
        onClose={onClose}
        onSelect={onSelect}
        activeWorkspaceId={over.activeWorkspaceId ?? WORKSPACE.id}
        onWorkspaceDeleted={onWorkspaceDeleted}
        onWorkspaceUpdated={onWorkspaceUpdated}
      />
    </ConfirmProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { onClose, onSelect, onWorkspaceDeleted, onWorkspaceUpdated, ...utils };
}

// The delete-confirmation dialog (a ConfirmModal) carries its own role="dialog"
// titled "Delete workspace"; its CTA shares the label "Delete" with the row
// button, so scope to that dialog to click the confirm CTA unambiguously.
function clickDeleteConfirm() {
  const dialog = screen.getByRole("dialog", { name: "Delete workspace" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
}

// The confirmation's "Cancel" shares its label with the modal's footer dismiss
// button, so scope to the confirmation dialog to click the right one.
function clickDeleteCancel() {
  const dialog = screen.getByRole("dialog", { name: "Delete workspace" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
}

beforeEach(() => {
  mockOpenOrCreate.mockReset();
  mockUpdateWorkspace.mockReset();
  mockDeleteWorkspace.mockReset();
  mockPickDirectory.mockReset();
});

afterEach(() => {
  cleanup();
  mockListWorkspaces.mockReset();
});

describe("WorkspaceModal inline rename — Escape", () => {
  it("cancels the rename without opening the discard dialog", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose, getByText, queryByText, getByDisplayValue, queryByDisplayValue } =
      await renderModal();

    // Enter inline-rename mode: the edit input is seeded with the current name.
    fireEvent.click(getByText("Rename"));
    const input = getByDisplayValue("Alpha");

    // Escape now routes solely through the modal's close guard, which unwinds
    // the inline edit. It must NOT also pop the dirty-close confirmation.
    fireEvent.keyDown(input, { key: "Escape" });

    expect(queryByDisplayValue("Alpha")).toBeNull(); // edit canceled
    expect(queryByText("Discard changes?")).toBeNull(); // no spurious discard
    expect(getByText("Rename")).toBeTruthy(); // back to the row's normal actions
    expect(onClose).not.toHaveBeenCalled(); // and the modal itself stays open
  });

  it("closes the modal on the next Escape once no edit is in progress", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose, getByText, getByDisplayValue } = await renderModal();

    fireEvent.click(getByText("Rename"));
    fireEvent.keyDown(getByDisplayValue("Alpha"), { key: "Escape" }); // unwinds the edit
    expect(onClose).not.toHaveBeenCalled();

    // The create form is untouched (not dirty), so the modal closes directly.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceModal — loading and empty states", () => {
  it("shows the loading placeholder until the list resolves", async () => {
    // A pending list keeps the modal in its loading state.
    let resolve!: (ws: Workspace[]) => void;
    mockListWorkspaces.mockReturnValue(new Promise<Workspace[]>((r) => (resolve = r)));
    const { getByText, queryByText } = await renderWith();
    expect(getByText("Loading...")).toBeTruthy();
    await act(async () => {
      resolve([WORKSPACE]);
      await Promise.resolve();
    });
    expect(queryByText("Loading...")).toBeNull();
    expect(getByText("Alpha")).toBeTruthy();
  });

  it("shows the empty-state hint when no workspaces exist", async () => {
    mockListWorkspaces.mockResolvedValue([]);
    const { getByText } = await renderWith();
    expect(getByText("No workspaces yet. Open or create one to get started.")).toBeTruthy();
  });

  it("leaves loading even when the list load fails (catch path)", async () => {
    mockListWorkspaces.mockRejectedValue(new Error("disk gone"));
    const { queryByText } = await renderWith();
    await act(async () => {
      await Promise.resolve();
    });
    // The empty-state shows once loading settles via the catch branch.
    expect(queryByText("Loading...")).toBeNull();
  });
});

describe("WorkspaceModal — create/open submit", () => {
  it("opens or creates a workspace from the typed name/location and selects it", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const created: Workspace = { id: "ws2", name: "Beta", dataDirectory: "/data/beta" };
    mockOpenOrCreate.mockResolvedValue(created);
    const onSelect = vi.fn();
    const { getByPlaceholderText, getByText } = await renderWith({ onSelect });

    fireEvent.change(getByPlaceholderText("Uses the folder name if available"), {
      target: { value: "Beta" },
    });
    fireEvent.change(getByPlaceholderText("Default location if blank"), {
      target: { value: "/data/beta" },
    });

    await act(async () => {
      fireEvent.click(getByText("Open or Create"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOpenOrCreate).toHaveBeenCalledWith("Beta", "/data/beta");
    expect(onSelect).toHaveBeenCalledWith(created);
  });

  it("passes undefined for blank name/location, and submits on Enter", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockOpenOrCreate.mockResolvedValue(WORKSPACE);
    const { getByPlaceholderText } = await renderWith();

    await act(async () => {
      fireEvent.keyDown(getByPlaceholderText("Uses the folder name if available"), {
        key: "Enter",
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOpenOrCreate).toHaveBeenCalledWith(undefined, undefined);
  });

  it("surfaces a submit failure as a field error and keeps the form open", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockOpenOrCreate.mockRejectedValue(new Error("folder is not empty"));
    const { getByPlaceholderText, getByText } = await renderWith();

    fireEvent.change(getByPlaceholderText("Uses the folder name if available"), {
      target: { value: "Beta" },
    });
    await act(async () => {
      fireEvent.click(getByText("Open or Create"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getByText("folder is not empty")).toBeTruthy();
  });
});

describe("WorkspaceModal — Browse", () => {
  it("fills the location from the directory picker when one is chosen", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockResolvedValue("/picked/dir");
    const { getByText, getByDisplayValue } = await renderWith();

    await act(async () => {
      fireEvent.click(getByText("Browse"));
      await Promise.resolve();
    });
    expect(getByDisplayValue("/picked/dir")).toBeTruthy();
  });

  it("leaves the location unchanged when the picker is cancelled", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockResolvedValue(null);
    const { getByText, getByPlaceholderText } = await renderWith();

    await act(async () => {
      fireEvent.click(getByText("Browse"));
      await Promise.resolve();
    });
    expect((getByPlaceholderText("Default location if blank") as HTMLInputElement).value).toBe("");
  });
});

describe("WorkspaceModal — inline rename save", () => {
  it("renames via the Save button and notifies when the active workspace changed", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const renamed: Workspace = { ...WORKSPACE, name: "Renamed" };
    mockUpdateWorkspace.mockResolvedValue(renamed);
    const onWorkspaceUpdated = vi.fn();
    const { getByText, getByDisplayValue } = await renderWith({ onWorkspaceUpdated });

    fireEvent.click(getByText("Rename"));
    fireEvent.change(getByDisplayValue("Alpha"), { target: { value: "Renamed" } });
    await act(async () => {
      fireEvent.click(getByText("Save"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws1", { name: "Renamed" });
    expect(onWorkspaceUpdated).toHaveBeenCalledWith(renamed);
  });

  it("commits the rename on Enter in the edit field", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockUpdateWorkspace.mockResolvedValue({ ...WORKSPACE, name: "ViaEnter" });
    const { getByText, getByDisplayValue } = await renderWith();

    fireEvent.click(getByText("Rename"));
    const input = getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "ViaEnter" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUpdateWorkspace).toHaveBeenCalledWith("ws1", { name: "ViaEnter" });
  });

  it("does not notify when the renamed workspace is not the active one", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockUpdateWorkspace.mockResolvedValue({ ...WORKSPACE, name: "Renamed" });
    const onWorkspaceUpdated = vi.fn();
    // Active workspace is a different id, so the update is not propagated up.
    const { getByText, getByDisplayValue } = await renderWith({
      activeWorkspaceId: "other",
      onWorkspaceUpdated,
    });

    fireEvent.click(getByText("Rename"));
    fireEvent.change(getByDisplayValue("Alpha"), { target: { value: "Renamed" } });
    await act(async () => {
      fireEvent.click(getByText("Save"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUpdateWorkspace).toHaveBeenCalled();
    expect(onWorkspaceUpdated).not.toHaveBeenCalled();
  });

  it("ignores a rename submit when the edit field is blank (disabled Save / no-op)", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { getByText, getByDisplayValue } = await renderWith();

    fireEvent.click(getByText("Rename"));
    const input = getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "   " } });
    // The Save button is disabled, and Enter is guarded by the empty-name check.
    expect((getByText("Save").closest("button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      await Promise.resolve();
    });
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
  });

  it("cancels the inline edit via the Cancel button", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { getByText, queryByDisplayValue } = await renderWith();
    fireEvent.click(getByText("Rename"));
    // The inline-edit Cancel shares its label with the modal's footer dismiss
    // button; scope to the workspace row so the query is unambiguous.
    fireEvent.click(within(screen.getByRole("option")).getByText("Cancel"));
    expect(queryByDisplayValue("Alpha")).toBeNull();
    expect(getByText("Rename")).toBeTruthy();
  });
});

describe("WorkspaceModal — delete", () => {
  it("deletes a non-active workspace after confirmation", async () => {
    const other: Workspace = { id: "ws2", name: "Bravo", dataDirectory: "/data/bravo" };
    mockListWorkspaces.mockResolvedValue([WORKSPACE, other]);
    mockDeleteWorkspace.mockResolvedValue(undefined);
    const onWorkspaceDeleted = vi.fn().mockResolvedValue(true);
    const { getAllByText } = await renderWith({ onWorkspaceDeleted });

    // Two rows, two Delete buttons; remove the non-active "Bravo" (second row).
    fireEvent.click(getAllByText("Delete")[1]);
    await act(async () => {
      clickDeleteConfirm();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockDeleteWorkspace).toHaveBeenCalledWith("ws2");
    // The active-workspace pre-check is skipped for a non-active target.
    expect(onWorkspaceDeleted).not.toHaveBeenCalled();
  });

  it("runs the active-workspace pre-check before deleting the active one", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockDeleteWorkspace.mockResolvedValue(undefined);
    const onWorkspaceDeleted = vi.fn().mockResolvedValue(true);
    const { getByText } = await renderWith({ onWorkspaceDeleted });

    fireEvent.click(getByText("Delete")); // the row's Delete (active workspace)
    await act(async () => {
      clickDeleteConfirm();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onWorkspaceDeleted).toHaveBeenCalledWith("ws1");
    expect(mockDeleteWorkspace).toHaveBeenCalledWith("ws1");
  });

  it("holds the dialog open with the veto reason when the active session refuses to unwind", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const onWorkspaceDeleted = vi.fn().mockResolvedValue(false); // veto
    const { getByText, findByText } = await renderWith({ onWorkspaceDeleted });

    fireEvent.click(getByText("Delete"));
    await act(async () => {
      clickDeleteConfirm();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The vetoed deletion surfaces inline and does not call deleteWorkspace.
    expect(
      await findByText("Resolve the unsaved changes in the active workspace before deleting it."),
    ).toBeTruthy();
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
  });

  it("re-selects the active workspace and shows the error when deletion fails", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockDeleteWorkspace.mockRejectedValue(new Error("delete failed on disk"));
    const onSelect = vi.fn();
    const onWorkspaceDeleted = vi.fn().mockResolvedValue(true);
    const { getByText, findByText } = await renderWith({ onSelect, onWorkspaceDeleted });

    fireEvent.click(getByText("Delete"));
    await act(async () => {
      clickDeleteConfirm();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The failed active-delete restores the session and surfaces the error.
    expect(await findByText("delete failed on disk")).toBeTruthy();
    expect(onSelect).toHaveBeenCalledWith(WORKSPACE);
  });

  it("does not delete when the confirmation is cancelled", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { getByText } = await renderWith();

    fireEvent.click(getByText("Delete"));
    clickDeleteCancel();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
  });
});

describe("WorkspaceModal — dirty-close confirmation", () => {
  it("asks to discard when the create form is dirty, closing only after Discard", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose, getByPlaceholderText, getByRole, findByText } = await renderWith();

    fireEvent.change(getByPlaceholderText("Uses the folder name if available"), {
      target: { value: "dirty" },
    });
    // Escape routes through the close guard, which now sees a dirty form.
    fireEvent.keyDown(document, { key: "Escape" });

    expect(await findByText("Discard changes?")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "Discard" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the modal open when the discard is declined", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose, getByPlaceholderText, getByRole, findByText } = await renderWith();

    fireEvent.change(getByPlaceholderText("Uses the folder name if available"), {
      target: { value: "dirty" },
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await findByText("Discard changes?");
    fireEvent.click(getByRole("button", { name: "Keep Editing" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes directly via the close button when the form is clean", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose, getByLabelText } = await renderWith();
    fireEvent.click(getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceModal — non-dismissable", () => {
  it("hides the close button and ignores Escape and the backdrop", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose, queryByLabelText, container } = await renderWith({ dismissable: false });

    // No close button when the modal cannot be dismissed (first-run gate).
    expect(queryByLabelText("Close")).toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(container.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
  });
});
