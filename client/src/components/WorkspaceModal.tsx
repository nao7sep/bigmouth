import { useEffect, useState } from "react";
import {
  fetchWorkspaces,
  openOrCreateWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "../api";
import type { Workspace } from "../types";
import { ConfirmModal } from "./ConfirmModal";
import { ModalShell } from "./ModalShell";

interface WorkspaceModalProps {
  dismissable: boolean;
  onClose: () => void;
  onSelect: (workspace: Workspace) => void;
  activeWorkspaceId: string | null;
  onWorkspaceDeleted: (workspaceId: string) => void;
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
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const isDirty = name.trim() !== "" || location.trim() !== "" || editingId !== null;

  const clearForm = () => {
    setError(null);
    setName("");
    setLocation("");
  };

  const handleRequestClose = () => {
    if (!dismissable) return;
    if (showDiscardConfirm) return;
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  };

  const load = () => {
    setLoading(true);
    fetchWorkspaces()
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
      onSelect(workspace);
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

  const handleDelete = async (ws: Workspace) => {
    await deleteWorkspace(ws.id);
    setDeleteTarget(null);
    if (ws.id === activeWorkspaceId) {
      onWorkspaceDeleted(ws.id);
    }
    load();
  };

  const sorted = [...workspaces].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const preferredWorkspaceId =
    sorted.find((ws) => ws.id === activeWorkspaceId)?.id ?? sorted[0]?.id ?? null;

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
          <p style={{ color: "var(--bm-text-muted)" }}>Loading...</p>
        ) : sorted.length === 0 ? (
          <p style={{ color: "var(--bm-text-muted)", marginBottom: 12 }}>
            No workspaces yet. Open or create one to get started.
          </p>
        ) : (
          <div className="workspace-list">
            {sorted.map((ws) => (
              <div key={ws.id} className="workspace-item">
                {editingId === ws.id ? (
                  <div className="workspace-edit-row">
                    <input
                      className="form-input"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
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
                    <button
                      type="button"
                      className="workspace-item-main"
                      autoFocus={ws.id === preferredWorkspaceId}
                      onClick={() => onSelect(ws)}
                    >
                      <div className="workspace-item-name">{ws.name}</div>
                      <div className="workspace-item-dir">{ws.dataDirectory}</div>
                    </button>
                    <div className="workspace-item-actions">
                      <button
                        className="btn-toolbar"
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
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(ws);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
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
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            autoFocus={sorted.length === 0}
          />
        </div>
        <div className="form-field">
          <label className="form-label">
            Location <span style={{ color: "var(--bm-text-muted)", fontWeight: 400 }}>(optional)</span>
          </label>
          <input
            className="form-input"
            value={location}
            onChange={(e) => {
              setError(null);
              setLocation(e.target.value);
            }}
            placeholder="Default location if blank"
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
          />
          <p className="settings-hint">
            Type a path manually. `~/` works on macOS and Linux.
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

      {deleteTarget && (
        <ConfirmModal
          title="Delete workspace"
          message={`Remove "${deleteTarget.name}" from the workspace list? The data files on disk will not be deleted.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {showDiscardConfirm && (
        <ConfirmModal
          title="Discard changes?"
          message="You have unsaved workspace edits. Discard them and close?"
          confirmLabel="Discard"
          cancelLabel="Keep Editing"
          danger
          onConfirm={() => {
            setShowDiscardConfirm(false);
            setEditingId(null);
            clearForm();
            onClose();
          }}
          onCancel={() => setShowDiscardConfirm(false)}
        />
      )}
    </ModalShell>
  );
}
