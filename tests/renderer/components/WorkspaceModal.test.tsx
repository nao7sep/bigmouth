import { afterEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import type { Workspace } from "@shared/types";

// WorkspaceModal only talks to the main process through these four api calls.
vi.mock("@renderer/api", () => ({
  listWorkspaces: vi.fn(),
  openOrCreateWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
}));

import { WorkspaceModal } from "@renderer/components/WorkspaceModal";
import { ConfirmProvider } from "@renderer/components/ConfirmHost";
import { listWorkspaces } from "@renderer/api";

const mockListWorkspaces = vi.mocked(listWorkspaces);

const WORKSPACE: Workspace = { id: "ws1", name: "Alpha", dataDirectory: "/data/alpha" };

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
