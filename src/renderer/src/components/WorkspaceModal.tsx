import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listWorkspaces,
  openOrCreateWorkspace,
  updateWorkspace,
  deleteWorkspace,
  pickWorkspaceDirectory,
} from "../api";
import type { Workspace } from "@shared/types";
import { useConfirm } from "./ConfirmHost";
import { ModalShell } from "./ModalShell";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";
import { usePostListbox, type PostListRow } from "../hooks/usePostListbox";

const WORKSPACE_PAGE_SIZE = 10;

interface WorkspaceModalProps {
  dismissable: boolean;
  onClose: () => void;
  onSelect: (workspace: Workspace) => void | Promise<void>;
  activeWorkspaceId: string | null;
  onWorkspaceDeleted: (workspaceId: string) => boolean | Promise<boolean>;
  onWorkspaceUpdated: (workspace: Workspace) => void;
}

export function WorkspaceModal({
  dismissable,
  onClose,
  onSelect,
  activeWorkspaceId,
  onWorkspaceDeleted,
  onWorkspaceUpdated,
}: WorkspaceModalProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const confirm = useConfirm();

  const renameComposing = useComposing();
  const nameComposing = useComposing();
  const locationComposing = useComposing();

  const isDirty = name.trim() !== "" || location.trim() !== "";

  const clearForm = () => {
    setError(null);
    setName("");
    setLocation("");
  };

  const handleBrowse = async () => {
    const dir = await pickWorkspaceDirectory();
    if (dir) {
      setError(null);
      setLocation(dir);
    }
  };

  const handleRequestClose = () => {
    // An inline rename is a nested edit within the modal. Any close request
    // (Escape, backdrop, close button) unwinds that edit first instead of
    // closing the modal, keeping "cancel this edit" distinct from "leave the
    // modal" — and giving Escape a single, well-defined path through this one
    // guard rather than a competing handler on the input.
    if (editingId !== null) {
      setEditingId(null);
      return;
    }
    if (!dismissable) return;
    if (!isDirty) {
      onClose();
      return;
    }
    void (async () => {
      const ok = await confirm({
        title: "Discard changes?",
        message: "You have unsaved workspace edits. Discard them and close?",
        confirmLabel: "Discard",
        cancelLabel: "Keep Editing",
        danger: true,
      });
      if (ok) {
        clearForm();
        onClose();
      }
    })();
  };

  const load = () => {
    setLoading(true);
    listWorkspaces()
      .then((ws) => {
        setWorkspaces(ws);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await openOrCreateWorkspace(name.trim() || undefined, location.trim() || undefined);
      clearForm();
      load();
      await onSelect(workspace);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open or create workspace.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    const updated = await updateWorkspace(id, { name: editName.trim() });
    if (updated && updated.id === activeWorkspaceId) {
      onWorkspaceUpdated(updated);
    }
    setEditingId(null);
    load();
  };

  const handleDelete = (ws: Workspace) => {
    void confirm({
      title: "Delete workspace",
      message: `Remove "${ws.name}" from the workspace list? The data files on disk will not be deleted.`,
      confirmLabel: "Delete",
      danger: true,
      // The whole deletion runs inside onConfirm so the host keeps the dialog
      // busy while it runs and, on failure, holds it open with the reason shown.
      onConfirm: async () => {
        // Active-workspace pre-check has side effects (it flushes pending
        // changes and tears down the session), so it must run only after the
        // user confirms — not before opening the dialog. A veto means the
        // session could not be unwound (unsaved changes); throw so the dialog
        // stays open and the deletion does not proceed.
        if (ws.id === activeWorkspaceId) {
          const canDelete = await onWorkspaceDeleted(ws.id);
          if (!canDelete) {
            throw new Error("Resolve the unsaved changes in the active workspace before deleting it.");
          }
        }
        try {
          await deleteWorkspace(ws.id);
        } catch (err) {
          // Deletion failed: if this was the active workspace, the pre-check
          // already cleared it, so re-select it to restore the session before
          // surfacing the error. Re-throw so the host shows it in the dialog.
          if (ws.id === activeWorkspaceId) {
            await onSelect(ws);
          }
          throw err instanceof Error ? err : new Error("Failed to delete workspace.");
        }
        load();
      },
    });
  };

  const sorted = useMemo(
    () =>
      [...workspaces].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      ),
    [workspaces]
  );
  const preferredWorkspaceId =
    sorted.find((ws) => ws.id === activeWorkspaceId)?.id ?? sorted[0]?.id ?? null;

  // The workspace list is one listbox per the composite-control conventions:
  // one tab stop, arrow navigation, type-ahead by name, Enter/click to open.
  // The per-row Rename/Delete buttons are pointer-only (not tab stops); deleting
  // recovers the cursor to a neighbour via the hook's removal recovery.
  const listComposing = useComposing();
  const rows: PostListRow[] = useMemo(
    () => sorted.map((ws) => ({ id: ws.id, label: ws.name })),
    [sorted]
  );
  const handleActivateWorkspace = useCallback(
    (id: string) => {
      const ws = sorted.find((w) => w.id === id);
      if (ws) void onSelect(ws);
    },
    [sorted, onSelect]
  );
  const { listboxProps, getRowProps, activeId } = usePostListbox({
    rows,
    selectedId: preferredWorkspaceId,
    onActivate: handleActivateWorkspace,
    pageSize: WORKSPACE_PAGE_SIZE,
    composingRef: listComposing.composingRef,
  });

  return (
    <ModalShell
      title="Workspaces"
      onClose={handleRequestClose}
      width={520}
      maxHeight="85vh"
      closeOnBackdrop={dismissable}
      showClose={dismissable}
    >
      <div className="modal-body">
        {loading ? (
          <p className="modal-empty-message">Loading...</p>
        ) : sorted.length === 0 ? (
          <p className="modal-empty-message">
            No workspaces yet. Open or create one to get started.
          </p>
        ) : (
          <div className="workspace-list" aria-label="Workspaces" {...listboxProps}>
            {sorted.map((ws) => {
              const editing = editingId === ws.id;
              const rowProps = getRowProps(ws.id);
              return (
                <div
                  key={ws.id}
                  className={`workspace-item${ws.id === activeId ? " active" : ""}`}
                  onCompositionStart={listComposing.handlers.onCompositionStart}
                  onCompositionEnd={listComposing.handlers.onCompositionEnd}
                  {...rowProps}
                  // While renaming, the row is not an activation target — the
                  // edit field owns it (see the inline-editing integration point).
                  onClick={editing ? undefined : rowProps.onClick}
                >
                  {editing ? (
                    <div
                      className="workspace-edit-row"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        className="form-input"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onCompositionStart={renameComposing.handlers.onCompositionStart}
                        onCompositionEnd={renameComposing.handlers.onCompositionEnd}
                        onKeyDown={(e) => {
                          // Keep navigation keys out of the listbox while editing.
                          e.stopPropagation();
                          if (isComposingKeyboardEvent(renameComposing.composingRef, e)) return;
                          if (e.key === "Enter") handleRename(ws.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        autoFocus
                      />
                      <button className="btn-toolbar" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                      <button
                        className="btn-primary"
                        style={{ width: "auto", padding: "4px 10px", fontSize: 12 }}
                        onClick={() => handleRename(ws.id)}
                        disabled={!editName.trim()}
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="workspace-item-main">
                        <div className="workspace-item-name">{ws.name}</div>
                        <div className="workspace-item-dir">{ws.dataDirectory}</div>
                      </div>
                      <div className="workspace-item-actions">
                        <button
                          className="btn-toolbar"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(ws.id);
                            setEditName(ws.name);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          className="btn-toolbar btn-delete"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(ws);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="workspace-create">
        <div className="workspace-create-heading">Open or Create Workspace</div>
        <div className="form-field">
          <label className="form-label">
            Name <span style={{ color: "var(--bm-text-muted)", fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            className="form-input"
            value={name}
            onChange={(e) => {
              setError(null);
              setName(e.target.value);
            }}
            placeholder="Uses the folder name if available"
            onCompositionStart={nameComposing.handlers.onCompositionStart}
            onCompositionEnd={nameComposing.handlers.onCompositionEnd}
            onKeyDown={(e) => {
              if (isComposingKeyboardEvent(nameComposing.composingRef, e)) return;
              if (e.key === "Enter") void handleSubmit();
            }}
            autoFocus={sorted.length === 0}
          />
        </div>
        <div className="form-field">
          <label className="form-label">
            Location <span style={{ color: "var(--bm-text-muted)", fontWeight: 400 }}>(optional)</span>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="form-input"
              style={{ flex: 1 }}
              value={location}
              onChange={(e) => {
                setError(null);
                setLocation(e.target.value);
              }}
              placeholder="Default location if blank"
              onCompositionStart={locationComposing.handlers.onCompositionStart}
              onCompositionEnd={locationComposing.handlers.onCompositionEnd}
              onKeyDown={(e) => {
                if (isComposingKeyboardEvent(locationComposing.composingRef, e)) return;
                if (e.key === "Enter") void handleSubmit();
              }}
            />
            <button className="btn-toolbar" type="button" onClick={() => void handleBrowse()}>
              Browse
            </button>
          </div>
          <p className="settings-hint">
            An existing folder must be empty or a BigMouth workspace.
          </p>
        </div>
        {error && <p className="settings-field-error">{error}</p>}
        <div className="dialog-actions">
          <button
            className="btn-primary"
            style={{ width: "auto" }}
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "Opening..." : "Open or Create"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
