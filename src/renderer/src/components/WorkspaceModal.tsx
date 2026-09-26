/**
 * The workspace picker — and, when no workspace is open, the app's root launch
 * gate.
 *
 * In that mode App renders it as the ENTIRE app with `dismissable={false}`,
 * which suppresses the ✕, the backdrop, Escape and the footer Cancel. That is
 * deliberate and the modal-dialog conventions permit it: a launch gate may omit
 * a dismiss button because there is no "cancel" target behind it — nothing to
 * return to. The same conventions require the exemption to be documented in the
 * file, which is what this paragraph is; without it a reader (or a naming audit)
 * finds a modal with every dismiss path removed and no recorded reason.
 *
 * With a workspace already open it is an ordinary dismissable modal.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listWorkspaces,
  openOrCreateWorkspace,
  updateWorkspace,
  deleteWorkspace,
  pickWorkspaceDirectory,
} from "../api";
import { presentFailure } from "../util/presentFailure";
import type { Workspace } from "@shared/types";
import { useConfirm } from "./ConfirmHost";
import { ModalShell } from "./ModalShell";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";
import { usePostListbox, type PostListRow } from "../hooks/usePostListbox";
import { OperationalResult } from "./OperationalResult";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";

const WORKSPACE_PAGE_SIZE = 10;

interface WorkspaceModalProps {
  dismissable: boolean;
  onClose: () => void;
  onSelect: (workspace: Workspace) => void | Promise<void>;
  activeWorkspaceId: string | null;
  onWorkspaceDeleted: (workspaceId: string) => boolean | Promise<boolean>;
  onWorkspaceUpdated: (workspace: Workspace) => void;
  initialLoadError?: Message | null;
  onLoadRecovered?: () => void;
}

export function WorkspaceModal({
  dismissable,
  onClose,
  onSelect,
  activeWorkspaceId,
  onWorkspaceDeleted,
  onWorkspaceUpdated,
  initialLoadError = null,
  onLoadRecovered,
}: WorkspaceModalProps) {
  const { t, text } = useI18n();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [error, setError] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [listError, setListError] = useState<Message | null>(initialLoadError);
  const [renameError, setRenameError] = useState<{ id: string; message: Message } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const confirm = useConfirm();

  const renameComposing = useComposing();
  const nameComposing = useComposing();
  const locationComposing = useComposing();

  const isDirty = name.trim() !== "" || location !== "";

  const clearForm = () => {
    setError(null);
    setName("");
    setLocation("");
  };

  const handleBrowse = async () => {
    try {
      const dir = await pickWorkspaceDirectory();
      if (dir) {
        setError(null);
        setLocation(dir);
      }
    } catch (err) {
      setError(presentFailure(
        message("workspaces.pickerFailed"),
        "renderer: workspace folder picker failed",
        err,
      ));
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
        title: t("workspaces.discardTitle"),
        message: t("workspaces.discardMessage"),
        confirmLabel: t("common.discard"),
        cancelLabel: t("common.keepEditing"),
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
        setListError(null);
        onLoadRecovered?.();
        setLoading(false);
      })
      .catch((err: unknown) => {
        setListError(presentFailure(
          message("workspaces.loadFailed"),
          "renderer: workspace registry load failed",
          err,
        ));
        setLoading(false);
      });
  };

  useEffect(() => {
    load();
  }, []);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const workspace = await openOrCreateWorkspace(name.trim() || undefined, location === "" ? undefined : location);
      clearForm();
      load();
      await onSelect(workspace);
    } catch (err) {
      setError(presentFailure(
        message("workspaces.openFailed"),
        "renderer: workspace open or creation failed",
        err,
      ));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRename = async (id: string) => {
    if (!editName.trim()) return;
    setRenamingId(id);
    setRenameError(null);
    try {
      const updated = await updateWorkspace(id, { name: editName.trim() });
      if (updated && updated.id === activeWorkspaceId) onWorkspaceUpdated(updated);
      setEditingId(null);
      load();
    } catch (err) {
      setRenameError({
        id,
        message: presentFailure(
          message("workspaces.renameFailed"),
          "renderer: workspace rename failed",
          err,
          { workspaceId: id },
        ),
      });
    } finally {
      setRenamingId(null);
    }
  };

  const handleDelete = (ws: Workspace) => {
    void confirm({
      title: t("workspaces.deleteTitle"),
      message: t("workspaces.deleteMessage", { name: ws.name }),
      confirmLabel: t("common.delete"),
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
    // The row buttons sit outside the tab order, as the composite-control
    // conventions require — so the keys are how a keyboard reaches them.
    onRowAction: (id, action) => {
      const ws = workspaces.find((w) => w.id === id);
      if (!ws) return;
      if (action === "rename") {
        setEditingId(ws.id);
        setEditName(ws.name);
        return;
      }
      void handleDelete(ws);
    },
    pageSize: WORKSPACE_PAGE_SIZE,
    composingRef: listComposing.composingRef,
  });

  return (
    <ModalShell
      title={t("workspaces.title")}
      onClose={handleRequestClose}
      width={520}
      maxHeight="85vh"
      closeOnBackdrop={dismissable}
      showClose={dismissable}
    >
      <div className="modal-body">
        {loading ? (
          <p className="modal-empty-message">{t("common.loading")}</p>
        ) : listError ? (
          <div className="workspace-load-recovery">
            <OperationalResult severity="error" className="modal-result">{text(listError)}</OperationalResult>
            <div className="dialog-actions">
              <button className="btn-action" type="button" onClick={load}>{t("common.retry")}</button>
            </div>
          </div>
        ) : sorted.length === 0 ? (
          <p className="modal-empty-message">{t("workspaces.empty")}</p>
        ) : (
          <div className="workspace-list" aria-label={t("workspaces.title")} {...listboxProps}>
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
                      className="workspace-edit-stack"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="workspace-edit-row"><input
                        className="form-input"
                        value={editName}
                        onChange={(e) => { setRenameError(null); setEditName(e.target.value); }}
                        onCompositionStart={renameComposing.handlers.onCompositionStart}
                        onCompositionEnd={renameComposing.handlers.onCompositionEnd}
                        onKeyDown={(e) => {
                          // Keep navigation keys out of the listbox while editing.
                          e.stopPropagation();
                          if (isComposingKeyboardEvent(renameComposing.composingRef, e)) return;
                          if (e.key === "Enter") handleRename(ws.id);
                          if (e.key === "Escape") { setRenameError(null); setEditingId(null); }
                        }}
                        autoFocus
                        disabled={renamingId === ws.id}
                      />
                      <button className="btn-action" disabled={renamingId === ws.id} onClick={() => { setRenameError(null); setEditingId(null); }}>
                        {t("common.cancel")}
                      </button>
                      <button
                        className="btn-primary"
                        onClick={() => handleRename(ws.id)}
                        disabled={!editName.trim() || renamingId === ws.id}
                      >
                        {renamingId === ws.id ? t("common.saving") : t("common.save")}
                      </button>
                      </div>
                      {renameError?.id === ws.id && (
                        <OperationalResult severity="error" className="modal-result workspace-rename-result">{text(renameError.message)}</OperationalResult>
                      )}
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
                            setRenameError(null);
                          }}
                        >
                          {t("common.rename")}
                        </button>
                        <button
                          className="btn-toolbar btn-delete"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(ws);
                          }}
                        >
                          {t("common.delete")}
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
        <div className="workspace-create-heading">{t("workspaces.createHeading")}</div>
        <div className="form-field">
          <label className="form-label">
            {t("workspaces.name")} <span style={{ color: "var(--bm-text-muted)", fontWeight: 400 }}>{t("common.optional")}</span>
          </label>
          <input
            className="form-input"
            value={name}
            onChange={(e) => {
              setError(null);
              setName(e.target.value);
            }}
            placeholder={t("workspaces.namePlaceholder")}
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
            {t("workspaces.location")} <span style={{ color: "var(--bm-text-muted)", fontWeight: 400 }}>{t("common.optional")}</span>
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
              placeholder={t("workspaces.locationPlaceholder")}
              onCompositionStart={locationComposing.handlers.onCompositionStart}
              onCompositionEnd={locationComposing.handlers.onCompositionEnd}
              onKeyDown={(e) => {
                if (isComposingKeyboardEvent(locationComposing.composingRef, e)) return;
                if (e.key === "Enter") void handleSubmit();
              }}
            />
            <button className="btn-action" type="button" onClick={() => void handleBrowse()}>
              {t("common.browse")}
            </button>
          </div>
          <p className="settings-hint">{t("workspaces.locationHint")}</p>
        </div>
        {error && (
          <OperationalResult severity="error" className="modal-result">
            {text(error)}
          </OperationalResult>
        )}
        <div className="dialog-actions">
          {dismissable && (
            <button
              className="btn-action"
              onClick={handleRequestClose}
              disabled={submitting}
            >
              {t("common.cancel")}
            </button>
          )}
          <button
            className="btn-primary"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? t("workspaces.opening") : t("workspaces.openOrCreate")}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
