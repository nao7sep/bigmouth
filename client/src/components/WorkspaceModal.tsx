import { useEffect, useState } from "react";
import { fetchWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace } from "../api";
import type { Workspace } from "../types";
import { useEscapeKey } from "../hooks/useEscapeKey";
import { ConfirmModal } from "./ConfirmModal";

interface WorkspaceModalProps {
  /** When true, the modal can be dismissed (user already has a workspace selected). */
  dismissable: boolean;
  onClose: () => void;
  onSelect: (workspace: Workspace) => void;
  activeWorkspaceId: string | null;
  onWorkspaceDeleted: (workspaceId: string) => void;
}

export function WorkspaceModal({
  dismissable,
  onClose,
  onSelect,
  activeWorkspaceId,
  onWorkspaceDeleted,
}: WorkspaceModalProps) {
  useEscapeKey(dismissable ? onClose : () => {});
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDir, setNewDir] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Workspace | null>(null);

  const load = () => {
    fetchWorkspaces()
      .then((ws) => { setWorkspaces(ws); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createWorkspace(newName.trim(), newDir.trim() || undefined);
      setNewName("");
      setNewDir("");
      load();
    } finally {
      setCreating(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    await updateWorkspace(id, { name: editName.trim() });
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

  return (
    <div className="modal-backdrop" onClick={dismissable ? onClose : undefined}>
      <div
        className="modal"
        style={{ width: 480, maxHeight: "85vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Workspaces</h2>
          {dismissable && (
            <button className="modal-close" onClick={onClose}>
              &times;
            </button>
          )}
        </div>

        <div className="modal-body">
          {loading ? (
            <p style={{ color: "#888" }}>Loading...</p>
          ) : sorted.length === 0 ? (
            <p style={{ color: "#888", marginBottom: 12 }}>
              No workspaces yet. Create one to get started.
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
                      <button
                        className="btn-toolbar"
                        onClick={() => handleRename(ws.id)}
                        disabled={!editName.trim()}
                      >
                        Save
                      </button>
                      <button
                        className="btn-toolbar"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      <div
                        className="workspace-item-main"
                        onClick={() => onSelect(ws)}
                      >
                        <div className="workspace-item-name">{ws.name}</div>
                        <div className="workspace-item-dir">{ws.dataDirectory}</div>
                      </div>
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

          <div className="workspace-create">
            <div className="workspace-create-heading">New workspace</div>
            <div className="form-field">
              <label className="form-label">Name</label>
              <input
                className="form-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My Workspace"
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
              />
            </div>
            <div className="form-field">
              <label className="form-label">
                Data directory <span style={{ color: "#888", fontWeight: 400 }}>(optional, uses default if blank)</span>
              </label>
              <input
                className="form-input"
                value={newDir}
                onChange={(e) => setNewDir(e.target.value)}
                placeholder="/path/to/custom/directory"
              />
            </div>
            <button
              className="btn-new-post"
              style={{ width: "auto" }}
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
            >
              {creating ? "Creating..." : "Create"}
            </button>
          </div>
        </div>

        {deleteTarget && (
          <ConfirmModal
            title="Delete workspace"
            message={`Delete "${deleteTarget.name}" and all its data? This cannot be undone.`}
            confirmLabel="Delete"
            danger
            onConfirm={() => handleDelete(deleteTarget)}
            onCancel={() => setDeleteTarget(null)}
          />
        )}
      </div>
    </div>
  );
}
