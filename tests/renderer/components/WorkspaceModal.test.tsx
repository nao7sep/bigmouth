import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type { Workspace, WorkspaceDeleteResult } from "@shared/types";

// WorkspaceModal talks to the main process through these api calls:
// pickWorkspaceDirectory backs both "Change" (a parent for a new workspace)
// and "Add Existing Folder" (a folder that already holds one).
vi.mock("@renderer/api", () => ({
  reportProblem: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  addExistingWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  pickWorkspaceDirectory: vi.fn(),
  suggestWorkspaceLocation: vi.fn(),
  getStoragePending: vi.fn(async () => false),
  onStoragePendingChanged: vi.fn(() => () => {}),
}));

import { WorkspaceModal } from "@renderer/components/WorkspaceModal";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import { StoragePendingContext, StoragePendingProvider, StoragePendingResults } from "@renderer/StoragePending";
import { carryingText } from "@shared/i18n/carriedMessage";
import { message } from "@shared/i18n/translate";
import {
  listWorkspaces,
  createWorkspace,
  addExistingWorkspace,
  updateWorkspace,
  deleteWorkspace,
  pickWorkspaceDirectory,
  suggestWorkspaceLocation,
} from "@renderer/api";

const mockListWorkspaces = vi.mocked(listWorkspaces);
const mockCreate = vi.mocked(createWorkspace);
const mockAddExisting = vi.mocked(addExistingWorkspace);
const mockUpdateWorkspace = vi.mocked(updateWorkspace);
const mockDeleteWorkspace = vi.mocked(deleteWorkspace);
const mockPickDirectory = vi.mocked(pickWorkspaceDirectory);
const mockSuggestLocation = vi.mocked(suggestWorkspaceLocation);
const mockWriteRendererLog = vi.fn();

const WORKSPACE: Workspace = { id: "ws1", name: "Alpha", dataDirectory: "/data/alpha" };
const OTHER: Workspace = { id: "ws2", name: "Bravo", dataDirectory: "/data/bravo" };
const CREATED: Workspace = { id: "ws3", name: "Beta", dataDirectory: "/home/me/Documents/BigMouth/Beta" };

// jsdom has no layout: the workspace listbox scrolls the active row into view,
// so stub scrollIntoView so arrowing/loading never throws.
beforeEach(() => {
  mockWriteRendererLog.mockReset();
  Object.defineProperty(window, "bigmouth", {
    configurable: true,
    value: { writeRendererLog: mockWriteRendererLog },
  });
  // What main answers: a folder named after the workspace, inside the chosen
  // parent or the default one.
  mockSuggestLocation.mockReset();
  mockSuggestLocation.mockImplementation(async (name?: string, parent?: string) =>
    `${parent ?? "/home/me/Documents/BigMouth"}/${name ?? "Workspace"}`);
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
  onCreated?: (ws: Workspace, firstRun: boolean) => void | Promise<void>;
  activeWorkspaceId?: string | null;
  onWorkspaceDeleted?: (id: string) => boolean | Promise<boolean>;
  onWorkspaceUpdated?: (ws: Workspace) => void;
  onWorkspaceRemovalCompleted?: (ws: Workspace, result: WorkspaceDeleteResult) => void;
  onWorkspaceRemovalFailed?: (ws: Workspace) => void | Promise<void>;
  reloadVersion?: number;
}

async function renderWith(over: ModalOverrides = {}) {
  const onClose = over.onClose ?? vi.fn();
  const onSelect = over.onSelect ?? vi.fn();
  const onWorkspaceDeleted = over.onWorkspaceDeleted ?? vi.fn().mockResolvedValue(true);
  const onWorkspaceUpdated = over.onWorkspaceUpdated ?? vi.fn();
  const element = (pending = false, shown = true) => (
    <StoragePendingProvider>
    <StoragePendingContext.Provider value={pending}>
    <ConfirmProvider>
      {shown && <WorkspaceModal
        dismissable={over.dismissable ?? true}
        onClose={onClose}
        onSelect={onSelect}
        onCreated={over.onCreated}
        activeWorkspaceId={over.activeWorkspaceId === undefined ? WORKSPACE.id : over.activeWorkspaceId}
        onWorkspaceDeleted={onWorkspaceDeleted}
        onWorkspaceUpdated={onWorkspaceUpdated}
        onWorkspaceRemovalCompleted={over.onWorkspaceRemovalCompleted}
        onWorkspaceRemovalFailed={over.onWorkspaceRemovalFailed}
        reloadVersion={over.reloadVersion}
      />}
    </ConfirmProvider>
    </StoragePendingContext.Provider>
    <StoragePendingResults />
    </StoragePendingProvider>
  );
  const utils = render(element());
  await act(async () => {
    await Promise.resolve();
  });
  return { onClose, onSelect, onWorkspaceDeleted, onWorkspaceUpdated, ...utils,
    rerenderPending: (pending: boolean) => utils.rerender(element(pending)),
    leaveModal: () => utils.rerender(element(true, false)),
  };
}

// The delete-confirmation dialog (a ConfirmModal) carries its own role="dialog"
// titled "Remove workspace"; its CTA shares the label "Remove" with the row
// button, so scope to that dialog to click the confirm CTA unambiguously.
function clickDeleteConfirm() {
  const dialog = screen.getByRole("dialog", { name: "Remove workspace" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
}

// The confirmation's "Cancel" shares its label with the modal's footer dismiss
// button, so scope to the confirmation dialog to click the right one.
function clickDeleteCancel() {
  const dialog = screen.getByRole("dialog", { name: "Remove workspace" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
}

// The window's own footer: its Cancel/Close shares labels with the ✕ and with
// an inline rename's Cancel.
function footerButton(container: HTMLElement, name: string) {
  return within(container.querySelector(".modal-footer") as HTMLElement).getByRole("button", { name });
}

function option(name: string) {
  return screen.getByRole("option", { name: new RegExp(`^${name}`) });
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

// Opens the new-workspace form over the list and types a name.
async function openNewForm(name?: string) {
  fireEvent.click(screen.getByRole("button", { name: "New Workspace" }));
  if (name !== undefined) fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  await flush();
}

beforeEach(() => {
  mockCreate.mockReset();
  mockAddExisting.mockReset();
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
    expect(getByText("Loading…")).toBeTruthy();
    await act(async () => {
      resolve([WORKSPACE]);
      await Promise.resolve();
    });
    expect(queryByText("Loading…")).toBeNull();
    expect(getByText("Alpha")).toBeTruthy();
  });


  it("shows authored recovery instead of a false empty state when loading fails", async () => {
    mockListWorkspaces.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH_SENTINEL"));
    const { queryByText, getByRole } = await renderWith();
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByText("Loading…")).toBeNull();
    expect(queryByText(/No workspaces yet/)).toBeNull();
    // Nothing to create into while the registry is unreadable.
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(getByRole("alert").textContent).toContain("saved registry is unchanged")
    expect(getByRole("alert").textContent).not.toContain("BIGMOUTH_SENTINEL")
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: workspace registry load failed",
    }));
  });
});

describe("WorkspaceModal — the list", () => {
  it("marks the open workspace as current and selects it to begin with", async () => {
    mockListWorkspaces.mockResolvedValue([OTHER, WORKSPACE]);
    await renderWith();
    // Sorted by name, whatever order the registry returned.
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual([
      "AlphaCurrent/data/alpha",
      "Bravo/data/bravo",
    ]);
    expect(option("Alpha").getAttribute("aria-selected")).toBe("true");
    expect(option("Bravo").getAttribute("aria-selected")).toBe("false");
  });

  it("keeps the add commands out of the footer, which holds only Cancel and Open", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { container } = await renderWith();
    const footer = within(container.querySelector(".modal-footer") as HTMLElement);
    expect(footer.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Open"]);
    const toolbar = within(container.querySelector(".workspace-toolbar") as HTMLElement);
    expect(toolbar.getAllByRole("button").map((button) => button.textContent)).toEqual(["New Workspace", "Add Existing Folder"]);
  });

  it("selects a clicked row without opening it", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE, OTHER]);
    const { onSelect } = await renderWith();
    fireEvent.click(option("Bravo"));
    expect(option("Bravo").getAttribute("aria-selected")).toBe("true");
    expect(option("Alpha").getAttribute("aria-selected")).toBe("false");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("moves the selection with the arrows without opening anything", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE, OTHER]);
    const { onSelect } = await renderWith();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    expect(option("Bravo").getAttribute("aria-selected")).toBe("true");
    expect(onSelect).not.toHaveBeenCalled();
  });

  // A row holds one line of name and one of folder; each keeps its whole value
  // as a tooltip, and Rename's field holds the whole name.
  it("shortens each row's name and folder", async () => {
    const longName = "Zeta, a workspace whose name runs on well past the width of any row";
    const longDir = "/Users/me/Documents/BigMouth/Clients/Long Running Project/Drafts/Gamma";
    const LONG: Workspace = { id: "ws9", name: longName, dataDirectory: longDir };
    mockListWorkspaces.mockResolvedValue([WORKSPACE, LONG]);
    await renderWith();
    const row = option(longName.slice(0, 10));
    const name = row.querySelector(".workspace-item-name-text") as HTMLElement;
    expect(name.textContent).toBe(longName);
    expect(name.getAttribute("title")).toBe(longName);
    expect(row.querySelector(".short-path")?.getAttribute("title")).toBe(longDir);
    expect(row.querySelector(".short-path-head")?.textContent).toBe("/Users/me/Documents/BigMouth/Clients/Long Running Project/Drafts/");
    expect(row.querySelector(".short-path-tail")?.textContent).toBe("Gamma");
  });

  it("opens a row on double-click", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE, OTHER]);
    const { onSelect } = await renderWith();
    fireEvent.doubleClick(option("Bravo"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(OTHER);
  });

  it("opens the selected row on Enter", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE, OTHER]);
    const { onSelect } = await renderWith();
    fireEvent.click(option("Bravo"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(OTHER);
  });

  it("opens the selected row with Open", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE, OTHER]);
    const { onSelect, container } = await renderWith();
    fireEvent.click(option("Bravo"));
    fireEvent.click(footerButton(container, "Open"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(OTHER);
  });

  it("opens the current workspace with Open when nothing else was chosen", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE, OTHER]);
    const { onSelect, container } = await renderWith({ activeWorkspaceId: OTHER.id });
    fireEvent.click(footerButton(container, "Open"));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(OTHER);
  });

  it("renames the selected row from Rename", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE, OTHER]);
    mockUpdateWorkspace.mockResolvedValue({ ...OTHER, name: "Bravo 2" });
    await renderWith();
    fireEvent.click(option("Bravo"));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByDisplayValue("Bravo");
    expect(screen.queryByDisplayValue("Alpha")).toBeNull();
    fireEvent.change(input, { target: { value: "Bravo 2" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(mockUpdateWorkspace).toHaveBeenCalledExactlyOnceWith("ws2", { name: "Bravo 2" });
  });

  it("disables the row actions and Open while a rename is open", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { container } = await renderWith();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect((screen.getByRole("button", { name: "Rename" }) as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector(".workspace-row-actions .btn-delete") as HTMLButtonElement).disabled).toBe(true);
    expect((footerButton(container, "Open") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("WorkspaceModal — first run", () => {
  it("opens on the new-workspace form, prefilled, with no way to dismiss it", async () => {
    mockListWorkspaces.mockResolvedValue([]);
    const { container, onClose } = await renderWith({ dismissable: false, activeWorkspaceId: null });
    await flush();

    expect(screen.getByRole("dialog", { name: "Set Up BigMouth" })).toBeTruthy();
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("My Blog");
    expect(screen.getByText("/home/me/Documents/BigMouth/My Blog")).toBeTruthy();
    expect(mockSuggestLocation).toHaveBeenLastCalledWith("My Blog", undefined);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText(/No workspaces yet/)).toBeNull();
    // A root launch gate: no Cancel, no ✕, and Escape and the backdrop do nothing.
    expect(within(container.querySelector(".modal-footer") as HTMLElement).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.queryByLabelText("Close")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(container.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    // Adding an existing folder is still offered.
    expect(screen.getByRole("button", { name: "Add Existing Folder" })).toBeTruthy();
  });

  it("reports the created workspace as the first run", async () => {
    mockListWorkspaces.mockResolvedValueOnce([]).mockResolvedValue([CREATED]);
    mockCreate.mockResolvedValue(CREATED);
    const onCreated = vi.fn();
    const { onSelect, container } = await renderWith({ dismissable: false, activeWorkspaceId: null, onCreated });
    await flush();

    await act(async () => { fireEvent.click(footerButton(container, "Create")); });

    expect(mockCreate).toHaveBeenCalledExactlyOnceWith("My Blog", undefined);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(CREATED, true);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("WorkspaceModal — New Workspace", () => {
  it("shows the folder the typed name would be created in", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { container } = await renderWith();
    await openNewForm();

    expect(screen.getByText("New Workspace")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect((footerButton(container, "Create") as HTMLButtonElement).disabled).toBe(true);
    // The form replaces its own opener while it is open.
    expect(screen.queryByRole("button", { name: "New Workspace" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Beta  " } });
    await flush();
    expect(mockSuggestLocation).toHaveBeenLastCalledWith("Beta", undefined);
    expect(screen.getByText("/home/me/Documents/BigMouth/Beta")).toBeTruthy();
    expect((footerButton(container, "Create") as HTMLButtonElement).disabled).toBe(false);
  });

  it("creates the named workspace and reports it as a later creation", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockCreate.mockResolvedValue(CREATED);
    const onCreated = vi.fn();
    const { onSelect, container } = await renderWith({ onCreated });
    await openNewForm("  Beta  ");

    await act(async () => { fireEvent.click(footerButton(container, "Create")); });

    expect(mockCreate).toHaveBeenCalledExactlyOnceWith("Beta", undefined);
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(CREATED, false);
    expect(onSelect).not.toHaveBeenCalled();
    // The list is reloaded and the form closed.
    expect(mockListWorkspaces).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("opens the created workspace like a selected one when no creation handler is given", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockCreate.mockResolvedValue(CREATED);
    const { onSelect } = await renderWith();
    await openNewForm("Beta");

    await act(async () => { fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" }); });

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(CREATED);
  });

  it("re-suggests inside the parent chosen with Change and creates there", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockCreate.mockResolvedValue(CREATED);
    // A picked path is used as given, spaces and all.
    mockPickDirectory.mockResolvedValue("/Volumes/ Data ");
    const { container } = await renderWith({ onCreated: vi.fn() });
    await openNewForm("Beta");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Change" })); });
    await flush();

    expect(mockPickDirectory).toHaveBeenCalledExactlyOnceWith("parent");
    expect(mockSuggestLocation).toHaveBeenLastCalledWith("Beta", "/Volumes/ Data ");
    expect(screen.getByText("/Volumes/ Data /Beta")).toBeTruthy();

    // The name still moves the folder within the chosen parent.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Gamma" } });
    await flush();
    expect(screen.getByText("/Volumes/ Data /Gamma")).toBeTruthy();

    await act(async () => { fireEvent.click(footerButton(container, "Create")); });
    expect(mockCreate).toHaveBeenCalledExactlyOnceWith("Gamma", "/Volumes/ Data ");
  });

  it("keeps the parent when the Change picker is cancelled", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockResolvedValue(null);
    await renderWith();
    await openNewForm("Beta");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Change" })); });
    await flush();

    expect(mockSuggestLocation).toHaveBeenLastCalledWith("Beta", undefined);
    expect(screen.getByText("/home/me/Documents/BigMouth/Beta")).toBeTruthy();
  });

  it("retains an authored form result when the Change picker rejects", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockRejectedValue(new Error("EACCES IPC /private/tmp/BIGMOUTH-PICKER-SENTINEL"));
    await renderWith();
    await openNewForm("Beta");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Change" })); });

    const result = screen.getByRole("alert");
    expect(result.textContent).toContain("location is unchanged");
    expect(result.textContent).not.toContain("BIGMOUTH-PICKER-SENTINEL");
    expect(screen.getByText("/home/me/Documents/BigMouth/Beta")).toBeTruthy();
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: workspace parent picker failed",
    }));
  });

  it("keeps the form usable with no preview when the suggestion fails", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockSuggestLocation.mockRejectedValue(new Error("storage busy"));
    const { container } = await renderWith();
    await openNewForm("Beta");

    expect(container.querySelector(".workspace-location")!.textContent).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((footerButton(container, "Create") as HTMLButtonElement).disabled).toBe(false);
  });

  it("surfaces a creation failure in place and keeps the form open", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockCreate.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH_CREATE_SENTINEL"));
    const onCreated = vi.fn();
    const { container } = await renderWith({ onCreated });
    await openNewForm("Beta");

    await act(async () => { fireEvent.click(footerButton(container, "Create")); });

    const result = screen.getByRole("alert");
    expect(result.textContent).toContain("The workspace could not be created.");
    expect(result.textContent).not.toContain("BIGMOUTH_CREATE_SENTINEL");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Beta");
    expect(onCreated).not.toHaveBeenCalled();
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: workspace creation failed",
    }));
  });
});

describe("WorkspaceModal — Add Existing Folder", () => {
  it("adds the picked folder and opens it", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const added: Workspace = { id: "ws4", name: "Notes", dataDirectory: "/picked/ Notes " };
    mockPickDirectory.mockResolvedValue("/picked/ Notes ");
    mockAddExisting.mockResolvedValue(added);
    const { onSelect } = await renderWith({ onCreated: vi.fn() });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add Existing Folder" })); });

    expect(mockPickDirectory).toHaveBeenCalledExactlyOnceWith("workspace");
    // A picked path is used as given, spaces and all.
    expect(mockAddExisting).toHaveBeenCalledExactlyOnceWith("/picked/ Notes ");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(added);
    expect(mockListWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the picker is cancelled", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockResolvedValue(null);
    const { onSelect } = await renderWith();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add Existing Folder" })); });

    expect(mockAddExisting).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the failure the folder carries in place", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockResolvedValue("/picked/notes");
    mockAddExisting.mockRejectedValue(new Error(carryingText(message("workspaces.notAWorkspace", { path: "/picked/notes" }))));
    const { onSelect } = await renderWith();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add Existing Folder" })); });

    expect(screen.getByRole("alert").textContent).toContain("/picked/notes does not hold a BigMouth workspace.");
    expect(onSelect).not.toHaveBeenCalled();
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: workspace add failed",
    }));
    // The list stays usable.
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("shows authored copy for a failure that carries no message of its own", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockResolvedValue("/picked/notes");
    mockAddExisting.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH_ADD_SENTINEL"));
    await renderWith();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add Existing Folder" })); });

    expect(screen.getByRole("alert").textContent).toContain("The folder could not be added.");
    expect(screen.getByRole("alert").textContent).not.toContain("BIGMOUTH_ADD_SENTINEL");
  });

  it("retains an authored result when the folder picker rejects", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockRejectedValue(new Error("EACCES IPC /private/tmp/BIGMOUTH-PICKER-SENTINEL"));
    await renderWith();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add Existing Folder" })); });

    expect(screen.getByRole("alert").textContent).toContain("location is unchanged");
    expect(screen.getByRole("alert").textContent).not.toContain("BIGMOUTH-PICKER-SENTINEL");
    expect(mockAddExisting).not.toHaveBeenCalled();
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: workspace folder picker failed",
    }));
  });

  it("is offered on first run too and opens the added folder", async () => {
    mockListWorkspaces.mockResolvedValue([]);
    mockAddExisting.mockResolvedValue(WORKSPACE);
    mockPickDirectory.mockResolvedValue("/data/alpha");
    const onCreated = vi.fn();
    const { onSelect } = await renderWith({ dismissable: false, activeWorkspaceId: null, onCreated });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add Existing Folder" })); });

    // Added, not created: it opens directly rather than continuing setup.
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(WORKSPACE);
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("WorkspaceModal — inline rename save", () => {
  it("checks an unsubmitted new-workspace draft when leaving a pending rename", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    let resolveRename!: (workspace: Workspace) => void;
    mockUpdateWorkspace.mockReturnValue(new Promise((resolve) => { resolveRename = resolve; }));
    const view = await renderWith();
    await openNewForm("Unsubmitted workspace");
    fireEvent.click(view.getByText("Rename"));
    fireEvent.change(view.getByDisplayValue("Alpha"), { target: { value: "Submitted name" } });
    fireEvent.click(view.getByText("Save"));
    view.rerenderPending(true);
    fireEvent.click(footerButton(view.container, "Cancel"));
    expect(view.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Discard changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await flush();
    expect(view.getByDisplayValue("Unsubmitted workspace")).toBeTruthy();
    fireEvent.click(footerButton(view.container, "Cancel"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Discard" })); });
    // Discarding the draft closes the form, not the window behind it.
    expect(view.queryByDisplayValue("Unsubmitted workspace")).toBeNull();
    expect(view.onClose).not.toHaveBeenCalled();
    fireEvent.click(footerButton(view.container, "Close"));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(mockUpdateWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => { resolveRename({ ...WORKSPACE, name: "Submitted name" }); });
    expect(view.onWorkspaceUpdated).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("keeps a departed rename failure in the app without reviving its editor", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    let rejectRename!: (error: Error) => void;
    mockUpdateWorkspace.mockReturnValue(new Promise((_, reject) => { rejectRename = reject; }));
    const view = await renderWith();
    fireEvent.click(view.getByText("Rename"));
    const input = view.getByDisplayValue("Alpha");
    fireEvent.change(input, { target: { value: "Submitted name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockUpdateWorkspace).toHaveBeenCalledTimes(1);
    view.rerenderPending(true);
    fireEvent.click(footerButton(view.container, "Close"));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    view.leaveModal();
    await act(async () => { rejectRename(new Error("private rename diagnostic")); });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("current name is unchanged");
    expect(screen.getByRole("alert").textContent).not.toContain("private rename diagnostic");
    expect(view.onWorkspaceUpdated).not.toHaveBeenCalled();
  });

  it("hands a committed active rename to App after its modal is removed", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    let resolveRename!: (workspace: Workspace) => void;
    mockUpdateWorkspace.mockReturnValue(new Promise((resolve) => { resolveRename = resolve; }));
    const view = await renderWith();
    fireEvent.click(view.getByText("Rename"));
    fireEvent.change(view.getByDisplayValue("Alpha"), { target: { value: "Renamed" } });
    fireEvent.click(view.getByText("Save"));
    view.leaveModal();
    const renamed = { ...WORKSPACE, name: "Renamed" };
    await act(async () => { resolveRename(renamed); });

    expect(view.onWorkspaceUpdated).toHaveBeenCalledExactlyOnceWith(renamed);
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("keeps the editor open with authored copy and logs hostile rename diagnostics", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockUpdateWorkspace.mockRejectedValue(new Error("EACCES /private/tmp/BIGMOUTH_RENAME_SENTINEL"));
    const { getByText, getByDisplayValue, getByRole } = await renderWith();

    fireEvent.click(getByText("Rename"));
    fireEvent.change(getByDisplayValue("Alpha"), { target: { value: "Renamed" } });
    await act(async () => { fireEvent.click(getByText("Save")); await Promise.resolve(); });

    expect(getByDisplayValue("Renamed")).toBeTruthy();
    expect(getByRole("alert").textContent).toContain("current name is unchanged")
    expect(getByRole("alert").textContent).not.toContain("BIGMOUTH_RENAME_SENTINEL")
    expect(mockWriteRendererLog).toHaveBeenCalledWith(expect.objectContaining({
      message: "renderer: workspace rename failed",
    }));
  });

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

describe("WorkspaceModal — pending creation and adding", () => {
  it("retains a failed creation after the modal leaves while pending", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    let rejectCreate!: (error: Error) => void;
    mockCreate.mockReturnValue(new Promise((_, reject) => { rejectCreate = reject; }));
    const onCreated = vi.fn();
    const view = await renderWith({ onCreated });
    await openNewForm("Beta");
    fireEvent.click(footerButton(view.container, "Create"));
    view.rerenderPending(true);
    fireEvent.click(footerButton(view.container, "Cancel"));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    view.leaveModal();
    await act(async () => { rejectCreate(new Error("private create diagnostic")); });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("The workspace could not be created.");
    expect(screen.getByRole("alert").textContent).not.toContain("private create diagnostic");
    expect(onCreated).not.toHaveBeenCalled();
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it("retains a failed add after the modal leaves while pending", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockResolvedValue("/picked/notes");
    let rejectAdd!: (error: Error) => void;
    mockAddExisting.mockReturnValue(new Promise((_, reject) => { rejectAdd = reject; }));
    const view = await renderWith();
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Add Existing Folder" })); });
    expect(view.getByRole("button", { name: "Opening…" })).toBeTruthy();
    view.rerenderPending(true);
    fireEvent.click(footerButton(view.container, "Close"));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    view.leaveModal();
    await act(async () => { rejectAdd(new Error("private add diagnostic")); });

    expect(screen.getByRole("alert").textContent).toContain("The folder could not be added.");
    expect(screen.getByRole("alert").textContent).not.toContain("private add diagnostic");
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it("does not open a row while a creation is in flight", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    let resolveCreate!: (workspace: Workspace) => void;
    mockCreate.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const onCreated = vi.fn();
    const { container, onSelect } = await renderWith({ onCreated });
    await openNewForm("Beta");
    fireEvent.click(footerButton(container, "Create"));
    expect(footerButton(container, "Creating…").hasAttribute("disabled")).toBe(true);
    fireEvent.doubleClick(option("Alpha"));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();

    await act(async () => { resolveCreate(CREATED); });
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(CREATED, false);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each(["Cancel", "✕", "Escape", "backdrop"] as const)("can leave via %s without replaying or adopting a late creation", async (path) => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    let resolveCreate!: (workspace: Workspace) => void;
    mockCreate.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    const onCreated = vi.fn();
    const { getByRole, getByLabelText, container, onClose, onSelect, rerenderPending } = await renderWith({ onCreated });
    await openNewForm("Submitted workspace");
    const name = getByLabelText("Name");
    fireEvent.click(footerButton(container, "Create"));
    // Enter remains a form submission path even when its button is disabled.
    fireEvent.keyDown(name, { key: "Enter" });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(name.hasAttribute("disabled")).toBe(true);
    rerenderPending(true);

    expect(getByRole("status").textContent).toContain("This change is still being saved.");
    const leave = footerButton(container, "Cancel");
    expect(leave.hasAttribute("disabled")).toBe(false);
    if (path === "Cancel") fireEvent.click(leave);
    else if (path === "✕") fireEvent.click(getByLabelText("Close"));
    else if (path === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else fireEvent.click(container.querySelector(".modal-backdrop")!);

    expect(onClose).toHaveBeenCalledTimes(1);
    // A submitted draft is not a discardable one.
    expect(screen.queryByText("Discard changes?")).toBeNull();
    await act(async () => { resolveCreate(CREATED); });
    expect(onCreated).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
  });
});

describe("WorkspaceModal — delete", () => {
  it("hands removal completion to the surviving owner after the active-session pre-check unmounts its modal", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockDeleteWorkspace.mockResolvedValue({ keyCleanupIncomplete: true });
    let unmountModal!: () => void;
    const onWorkspaceDeleted = vi.fn(async () => { unmountModal(); return true; });
    const completed = vi.fn();
    const view = await renderWith({ onWorkspaceDeleted, onWorkspaceRemovalCompleted: completed });
    unmountModal = view.unmount;
    fireEvent.click(view.getByText("Remove"));
    await act(async () => { clickDeleteConfirm(); await Promise.resolve(); });

    expect(completed).toHaveBeenCalledExactlyOnceWith(WORKSPACE, { keyCleanupIncomplete: true });
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it("delegates primary removal recovery to the surviving owner without selecting an old workspace itself", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockDeleteWorkspace.mockRejectedValue(new Error("registry write failed"));
    const failed = vi.fn();
    const view = await renderWith({ onWorkspaceRemovalFailed: failed });
    fireEvent.click(view.getByText("Remove"));
    await act(async () => { clickDeleteConfirm(); await Promise.resolve(); });

    expect(failed).toHaveBeenCalledExactlyOnceWith(WORKSPACE);
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(view.getByText('"Alpha" could not be removed. It remains in the workspace list; try again.')).toBeTruthy();
  });

  it("retires a removed active workspace and reloads while preserving its key cleanup warning", async () => {
    mockListWorkspaces.mockResolvedValueOnce([WORKSPACE]).mockResolvedValue([]);
    mockDeleteWorkspace.mockResolvedValue({ keyCleanupIncomplete: true });
    const onSelect = vi.fn();
    const onWorkspaceDeleted = vi.fn().mockResolvedValue(true);
    const { getByText, findByText, queryByRole } = await renderWith({ onSelect, onWorkspaceDeleted });

    fireEvent.click(getByText("Remove"));
    await act(async () => {
      clickDeleteConfirm();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onWorkspaceDeleted).toHaveBeenCalledWith(WORKSPACE.id);
    expect(onSelect).not.toHaveBeenCalled();
    expect(mockListWorkspaces).toHaveBeenCalledTimes(2);
    expect(await findByText('"Alpha" was removed from the workspace list, but its stored API key could not be cleared.')).toBeTruthy();
    expect(queryByRole("option")).toBeNull();
    expect(queryByRole("alertdialog")).toBeNull();
    // With nothing left, the window turns to creating one.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("My Blog");
    fireEvent.click(screen.getByRole("button", { name: "Close result" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("deletes the selected non-active workspace after confirmation", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE, OTHER]);
    mockDeleteWorkspace.mockResolvedValue({});
    const onWorkspaceDeleted = vi.fn().mockResolvedValue(true);
    const { getByText } = await renderWith({ onWorkspaceDeleted });

    // Remove acts on the selected row: choose the non-active "Bravo" first.
    fireEvent.click(option("Bravo"));
    fireEvent.click(getByText("Remove"));
    expect(screen.getByText(/Remove "Bravo" from the workspace list\?/)).toBeTruthy();
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
    mockDeleteWorkspace.mockResolvedValue({});
    const onWorkspaceDeleted = vi.fn().mockResolvedValue(true);
    const { getByText } = await renderWith({ onWorkspaceDeleted });

    fireEvent.click(getByText("Remove")); // the selected row is the active workspace
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

    fireEvent.click(getByText("Remove"));
    await act(async () => {
      clickDeleteConfirm();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The vetoed deletion surfaces inline and does not call deleteWorkspace.
    expect(
      await findByText('"Alpha" could not be removed. It remains in the workspace list; try again.'),
    ).toBeTruthy();
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
  });

  it("re-selects the active workspace and shows the error when deletion fails", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockDeleteWorkspace.mockRejectedValue(new Error("delete failed on disk"));
    const onSelect = vi.fn();
    const onWorkspaceDeleted = vi.fn().mockResolvedValue(true);
    const { getByText, findByText } = await renderWith({ onSelect, onWorkspaceDeleted });

    fireEvent.click(getByText("Remove"));
    await act(async () => {
      clickDeleteConfirm();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The failed active-delete restores the session and surfaces the error.
    expect(await findByText('"Alpha" could not be removed. It remains in the workspace list; try again.')).toBeTruthy();
    expect(onSelect).toHaveBeenCalledWith(WORKSPACE);
  });

  it("does not delete when the confirmation is cancelled", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { getByText } = await renderWith();

    fireEvent.click(getByText("Remove"));
    clickDeleteCancel();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockDeleteWorkspace).not.toHaveBeenCalled();
  });
});

describe("WorkspaceModal — closing the new-workspace form", () => {
  it("closes an untouched form without asking, leaving the window open", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose } = await renderWith();
    await openNewForm();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByText("Discard changes?")).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("button", { name: "New Workspace" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // The next Escape leaves the window.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks to discard a typed name, closing only the form after Discard", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose, getByRole, findByText } = await renderWith();
    await openNewForm("dirty");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(await findByText("Discard changes?")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Discard" }));
    await flush();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the form when the discard is declined", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onClose, container, getByRole, findByText } = await renderWith();
    await openNewForm("dirty");

    fireEvent.click(footerButton(container, "Cancel"));
    await findByText("Discard changes?");
    fireEvent.click(getByRole("button", { name: "Keep editing" }));
    await flush();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("dirty");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("treats a chosen parent as a change worth asking about", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    mockPickDirectory.mockResolvedValue("/Volumes/Data");
    const { findByText } = await renderWith();
    await openNewForm();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Change" })); });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(await findByText("Discard changes?")).toBeTruthy();
  });

  it("closes the window directly via the close button when no form is open", async () => {
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

// The row buttons carry tabIndex={-1}, which the composite-control conventions
// require — and then require the actions to be reachable another way: "drive
// them from within, by keys on the active row". Nothing did, so a keyboard-only
// user could arrow through the list and open a workspace, and nothing else.
describe("WorkspaceModal — row actions from the keyboard", () => {
  async function openList() {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    return renderModal();
  }

  it("Enter on the active row opens it", async () => {
    mockListWorkspaces.mockResolvedValue([WORKSPACE]);
    const { onSelect } = await renderWith();
    const listbox = screen.getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(WORKSPACE);
  });

  it("F2 on the active row starts a rename", async () => {
    const { getByRole, getByDisplayValue } = await openList();
    const listbox = getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "F2" });

    // The row turns into its rename field, seeded with the current name.
    expect(getByDisplayValue("Alpha")).toBeTruthy();
  });

  it("Delete on the active row asks to delete it", async () => {
    const { getByRole, findByText } = await openList();
    const listbox = getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "Delete" });

    expect(await findByText(/Remove "Alpha" from the workspace list\?/)).toBeTruthy();
  });

  // Enter already opens the active row (manual activation), so it cannot also
  // start a rename here — Cmd+R is the fallback the keyboard-shortcut
  // conventions call for when the natural (Finder-style) key is taken.
  it("Cmd+R on the active row starts a rename", async () => {
    const { getByRole, getByDisplayValue } = await openList();
    const listbox = getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "r", metaKey: true });

    expect(getByDisplayValue("Alpha")).toBeTruthy();
  });

  // Both halves of the command modifier are bound (keyboard-shortcut-conventions).
  it("Ctrl+R on the active row also starts a rename", async () => {
    const { getByRole, getByDisplayValue } = await openList();
    const listbox = getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "r", ctrlKey: true });

    expect(getByDisplayValue("Alpha")).toBeTruthy();
  });

  it("a bare 'r' does not start a rename (it is type-ahead, not a command)", async () => {
    const { getByRole, queryByDisplayValue } = await openList();
    const listbox = getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "r" });

    expect(queryByDisplayValue("Alpha")).toBeNull();
  });

  it("Cmd+Shift+R does not start a rename (only the plain chord is bound)", async () => {
    const { getByRole, queryByDisplayValue } = await openList();
    const listbox = getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "R", metaKey: true, shiftKey: true });

    expect(queryByDisplayValue("Alpha")).toBeNull();
  });

  // Alt is excluded from command-modifier matching everywhere in the app
  // (Chromium delivers Windows AltGr as Ctrl+Alt), so Cmd+Alt+R must not fire it.
  it("Cmd+Alt+R does not start a rename", async () => {
    const { getByRole, queryByDisplayValue } = await openList();
    const listbox = getByRole("listbox");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "r", metaKey: true, altKey: true });

    expect(queryByDisplayValue("Alpha")).toBeNull();
  });
});
