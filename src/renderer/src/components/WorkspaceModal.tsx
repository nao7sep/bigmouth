/**
 * The workspace list — and, when no workspace is open, the app's root launch
 * gate, first run included.
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
 *
 * The list is the window: a row is selected by click or arrows, opened by
 * Enter, double-click or Open, and renamed or removed from the buttons under
 * the list. The commands that add a workspace sit in a toolbar band above the
 * list, so the footer holds only the dismiss and the commit (Cancel and Open,
 * or Cancel and Create). A workspace's folder is never typed. "New Workspace" creates one
 * at the displayed destination, which the user may change;
 * "Add Existing Folder" registers a folder that already holds a workspace.
 * With nothing registered, the new-workspace form is shown straight away.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  addExistingWorkspace,
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  pickWorkspaceDirectory,
  reportProblem,
  suggestWorkspaceLocation,
  updateWorkspace,
} from "../api";
import { presentFailure } from "../util/presentFailure";
import type { Workspace, WorkspaceDeleteResult } from "@shared/types";
import { useConfirm } from "./ConfirmHost";
import { ModalShell } from "./ModalShell";
import { useComposing, isComposingKeyboardEvent } from "../hooks/useComposing";
import { usePostListbox, type PostListRow } from "../hooks/usePostListbox";
import { OperationalResult } from "./OperationalResult";
import { ShortPath } from "./ShortPath";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import { StoragePendingNotice, useStoragePending, useStorageResultReporter } from "../StoragePending";

interface WorkspaceModalProps {
  dismissable: boolean;
  onClose: () => void;
  onSelect: (workspace: Workspace) => void | Promise<void>;
  /**
   * A workspace this window just created. `firstRun` is true when it is the
   * only one registered, so the caller can continue first-run setup. Without
   * this callback a created workspace opens like a selected one.
   */
  onCreated?: (workspace: Workspace, firstRun: boolean) => void | Promise<void>;
  activeWorkspaceId: string | null;
  onWorkspaceDeleted: (workspaceId: string) => boolean | Promise<boolean>;
  onWorkspaceUpdated: (workspace: Workspace) => void;
  onWorkspaceRemovalCompleted?: (workspace: Workspace, result: WorkspaceDeleteResult) => void;
  onWorkspaceRemovalFailed?: (workspace: Workspace) => void | Promise<void>;
  reloadVersion?: number;
  initialLoadError?: Message | null;
  onLoadRecovered?: () => void;
}

export function WorkspaceModal({
  dismissable,
  onClose,
  onSelect,
  onCreated,
  activeWorkspaceId,
  onWorkspaceDeleted,
  onWorkspaceUpdated,
  onWorkspaceRemovalCompleted,
  onWorkspaceRemovalFailed,
  reloadVersion = 0,
  initialLoadError = null,
  onLoadRecovered,
}: WorkspaceModalProps) {
  const { t, text } = useI18n();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<Message | null>(initialLoadError);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [renameError, setRenameError] = useState<{ id: string; message: Message } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [removalWarnings, setRemovalWarnings] = useState<{ id: string; message: Message }[]>([]);
  // The new-workspace form. `createFrom` is the name it opened with, so an
  // untouched form leaves without asking.
  const [creatingForm, setCreatingForm] = useState(false);
  const [createFrom, setCreateFrom] = useState("");
  const [createName, setCreateName] = useState("");
  const [chosenLocation, setChosenLocation] = useState<string | null>(null);
  const [suggestedLocation, setSuggestedLocation] = useState("");
  const [createError, setCreateError] = useState<Message | null>(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<Message | null>(null);
  const current = useRef(true);
  const selectionIntent = useRef(0);
  const submittingRef = useRef(false);
  const renamingRef = useRef(false);
  const storagePending = useStoragePending();
  const reportStorageResult = useStorageResultReporter();
  const confirm = useConfirm();

  useEffect(() => {
    current.current = true;
    return () => { current.current = false; };
  }, []);

  const close = () => {
    selectionIntent.current += 1;
    current.current = false;
    onClose();
  };

  const renameComposing = useComposing();
  const nameComposing = useComposing();
  const listComposing = useComposing();
  const nameId = useId();
  const locationId = useId();

  const mutationBusy = creating || adding || renamingId !== null;
  const formDirty = creatingForm && (createName.trim() !== createFrom.trim() || chosenLocation !== null);

  const openCreateForm = (initialName: string) => {
    setCreateError(null);
    setCreateFrom(initialName);
    setCreateName(initialName);
    setChosenLocation(null);
    setSuggestedLocation("");
    setCreatingForm(true);
  };

  const closeCreateForm = () => {
    setCreateError(null);
    setCreatingForm(false);
    setCreateName("");
    setChosenLocation(null);
    setSuggestedLocation("");
  };

  const load = () => {
    setLoading(true);
    listWorkspaces()
      .then((ws) => {
        if (!current.current) return;
        setWorkspaces(ws);
        setListError(null);
        onLoadRecovered?.();
        setLoading(false);
        // Nothing to choose from: the window opens on the one thing to do.
        if (ws.length === 0 && !submittingRef.current) openCreateForm(t("setup.workspaceNameDefault"));
      })
      .catch((err: unknown) => {
        if (!current.current) { reportProblem("renderer: workspace registry load failed", err); return; }
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
  }, [reloadVersion]);

  useEffect(() => {
    if (!creatingForm || chosenLocation !== null) return;
    let current = true;
    suggestWorkspaceLocation(createName.trim() || undefined)
      .then((path) => {
        if (current) setSuggestedLocation(path);
      })
      .catch((err: unknown) => {
        // Keep creation disabled until a destination is known or selected.
        if (current) {
          setSuggestedLocation("");
          setCreateError(message("workspaces.locationFailed"));
        }
        reportProblem("renderer: workspace location suggestion failed", err);
      });
    return () => {
      current = false;
    };
  }, [createName, chosenLocation, creatingForm]);

  const handleRequestClose = () => {
    if (submittingRef.current || renamingRef.current) {
      // The submitted intent stays owned by storage after this view is left.
      if (!dismissable || !storagePending) return;
      if (submittingRef.current) { close(); return; }
    }
    // A nested edit — an inline rename or the new-workspace form over a list —
    // unwinds first, keeping "cancel this edit" distinct from "leave the window".
    if (editingId !== null && !renamingRef.current) {
      setEditingId(null);
      return;
    }
    if (creatingForm && workspaces.length > 0) {
      if (!formDirty) { closeCreateForm(); return; }
      void (async () => {
        const ok = await confirm({
          title: t("common.discardTitle"),
          message: t("common.discardMessage"),
          confirmLabel: t("common.discard"),
          cancelLabel: t("common.keepEditing"),
          danger: true,
        });
        if (ok && current.current) closeCreateForm();
      })();
      return;
    }
    if (!dismissable) return;
    close();
  };

  const handleChangeLocation = async () => {
    try {
      const dir = await pickWorkspaceDirectory("create", chosenLocation ?? (suggestedLocation || undefined));
      if (dir && current.current) {
        setCreateError(null);
        setChosenLocation(dir);
      }
    } catch (err) {
      const failure = presentFailure(message("workspaces.pickerFailed"), "renderer: workspace destination picker failed", err);
      if (current.current) setCreateError(failure);
    }
  };

  const handleCreate = async () => {
    const name = createName.trim();
    const location = chosenLocation ?? suggestedLocation;
    if (!name || !location || submittingRef.current || renamingRef.current || storagePending) return;
    submittingRef.current = true;
    const intent = ++selectionIntent.current;
    const firstRun = workspaces.length === 0;
    setCreating(true);
    setCreateError(null);
    try {
      const workspace = await createWorkspace(name, location);
      if (!current.current || selectionIntent.current !== intent) return;
      closeCreateForm();
      load();
      if (onCreated) await onCreated(workspace, firstRun);
      else await onSelect(workspace);
    } catch (err) {
      const failure = presentFailure(message("workspaces.createFailed"), "renderer: workspace creation failed", err);
      if (current.current && selectionIntent.current === intent) setCreateError(failure);
      else reportStorageResult(failure);
    } finally {
      submittingRef.current = false;
      if (current.current) setCreating(false);
    }
  };

  const handleAddExisting = async () => {
    if (submittingRef.current || renamingRef.current || storagePending) return;
    setAddError(null);
    setCreateError(null);
    let dir: string | null;
    try {
      dir = await pickWorkspaceDirectory("workspace", workspaces.find((ws) => ws.id === activeWorkspaceId)?.dataDirectory);
    } catch (err) {
      const failure = presentFailure(message("workspaces.pickerFailed"), "renderer: workspace folder picker failed", err);
      if (current.current) setAddError(failure);
      return;
    }
    if (!dir || !current.current || submittingRef.current) return;
    submittingRef.current = true;
    const intent = ++selectionIntent.current;
    setAdding(true);
    try {
      const workspace = await addExistingWorkspace(dir);
      if (!current.current || selectionIntent.current !== intent) return;
      closeCreateForm();
      load();
      await onSelect(workspace);
    } catch (err) {
      const failure = presentFailure(message("workspaces.addFailed"), "renderer: workspace add failed", err, { dataDirectory: dir });
      if (current.current && selectionIntent.current === intent) setAddError(failure);
      else reportStorageResult(failure);
    } finally {
      submittingRef.current = false;
      if (current.current) setAdding(false);
    }
  };

  const startRename = (ws: Workspace) => {
    setEditingId(ws.id);
    setEditName(ws.name);
    setRenameError(null);
  };

  const handleRename = async (id: string) => {
    if (!editName.trim() || renamingRef.current || submittingRef.current || storagePending) return;
    renamingRef.current = true;
    setRenamingId(id);
    setRenameError(null);
    try {
      const updated = await updateWorkspace(id, { name: editName.trim() });
      if (updated && updated.id === activeWorkspaceId) onWorkspaceUpdated(updated);
      if (!current.current) return;
      setEditingId(null);
      load();
    } catch (err) {
      const failure = presentFailure(
        message("workspaces.renameFailed"),
        "renderer: workspace rename failed",
        err,
        { workspaceId: id },
      );
      if (current.current) setRenameError({ id, message: failure });
      else reportStorageResult(failure);
    } finally {
      renamingRef.current = false;
      if (current.current) setRenamingId(null);
    }
  };

  const handleDelete = (ws: Workspace) => {
    if (storagePending || submittingRef.current || renamingRef.current) return;
    void confirm({
      title: t("workspaces.deleteTitle"),
      message: t("workspaces.deleteMessage", { name: ws.name }),
      confirmLabel: t("workspaces.remove"),
      failureMessage: message("workspaces.removeFailed", { name: ws.name }),
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
        let result: WorkspaceDeleteResult;
        try {
          result = await deleteWorkspace(ws.id);
        } catch (err) {
          // Deletion failed: if this was the active workspace, the pre-check
          // already cleared it, so re-select it to restore the session before
          // surfacing the error. Re-throw so the host shows it in the dialog.
          if (onWorkspaceRemovalFailed) {
            await onWorkspaceRemovalFailed(ws);
          } else if (current.current && ws.id === activeWorkspaceId) {
            await onSelect(ws);
          }
          throw err instanceof Error ? err : new Error("Failed to delete workspace.");
        }
        onWorkspaceRemovalCompleted?.(ws, result);
        if (result.keyCleanupIncomplete && !onWorkspaceRemovalCompleted) {
          const warning = message("workspaces.keyCleanupIncomplete", { name: ws.name });
          if (current.current) setRemovalWarnings((warnings) => [...warnings, { id: ws.id, message: warning }]);
          else reportStorageResult(warning, "warning");
        }
        if (!current.current) return;
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
  // The row the buttons act on: the user's choice while it is listed, else the
  // open workspace, else the first.
  const selectedId =
    sorted.find((ws) => ws.id === chosenId)?.id ??
    sorted.find((ws) => ws.id === activeWorkspaceId)?.id ??
    sorted[0]?.id ??
    null;
  const selected = sorted.find((ws) => ws.id === selectedId) ?? null;

  const handleOpen = useCallback(
    (id: string | null) => {
      const ws = sorted.find((w) => w.id === id);
      if (!ws || submittingRef.current || renamingRef.current) return;
      selectionIntent.current += 1;
      void onSelect(ws);
    },
    [sorted, onSelect]
  );

  // The workspace list is one listbox per the composite-control conventions:
  // one tab stop, arrows and type-ahead move the selection (choosing a row is
  // cheap and discards nothing), and Enter opens it. Rename and Remove are
  // ordinary buttons under the list, acting on the selected row; F2, Cmd+R and
  // Delete reach them from the list too.
  const rows: PostListRow[] = useMemo(
    () => sorted.map((ws) => ({ id: ws.id, label: ws.name })),
    [sorted]
  );
  const { listboxProps, getRowProps, activeId } = usePostListbox({
    rows,
    selectedId,
    onActivate: setChosenId,
    followFocus: true,
    autoActivateFirst: true,
    onRowAction: (id, action) => {
      if (storagePending || submittingRef.current || renamingRef.current) return;
      const ws = workspaces.find((w) => w.id === id);
      if (!ws) return;
      if (action === "rename") startRename(ws);
      else handleDelete(ws);
    },
    composingRef: listComposing.composingRef,
  });
  const onListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && !isComposingKeyboardEvent(listComposing.composingRef, e)) {
      e.preventDefault();
      handleOpen(activeId ?? selectedId);
      return;
    }
    listboxProps.onKeyDown(e);
  };

  const firstRun = !loading && !listError && sorted.length === 0;
  const rowActionsDisabled = !selected || storagePending || mutationBusy || editingId !== null;

  const createForm = (
    <div className="workspace-create">
      {firstRun ? (
        <p className="setup-intro">{t("setup.workspaceIntro")}</p>
      ) : (
        <div className="workspace-create-heading">{t("workspaces.createHeading")}</div>
      )}
      <div className="form-field">
        <label className="form-label" htmlFor={nameId}>{t("workspaces.name")}</label>
        <input
          id={nameId}
          className="form-input"
          value={createName}
          disabled={creating}
          onChange={(e) => {
            setCreateError(null);
            setCreateName(e.target.value);
          }}
          onCompositionStart={nameComposing.handlers.onCompositionStart}
          onCompositionEnd={nameComposing.handlers.onCompositionEnd}
          onKeyDown={(e) => {
            if (isComposingKeyboardEvent(nameComposing.composingRef, e)) return;
            if (e.key === "Enter") void handleCreate();
          }}
          autoFocus
        />
      </div>
      <div className="form-field">
        <span className="form-label" id={locationId}>{t("workspaces.location")}</span>
        <div className="workspace-location-row">
          <code className="workspace-location" aria-labelledby={locationId}>{chosenLocation ?? suggestedLocation}</code>
          <button className="btn-action" type="button" disabled={creating} onClick={() => void handleChangeLocation()}>
            {t("center.change")}
          </button>
        </div>
        <p className="settings-hint">{t("workspaces.locationHint")}</p>
      </div>
      {createError && (
        <OperationalResult severity="error" className="modal-result">
          {text(createError)}
        </OperationalResult>
      )}
    </div>
  );

  let body;
  if (loading) {
    body = <p className="modal-empty-message">{t("common.loading")}</p>;
  } else if (listError) {
    body = (
      <div className="workspace-load-recovery">
        <OperationalResult severity="error" className="modal-result">{text(listError)}</OperationalResult>
        <div className="dialog-actions">
          <button className="btn-action" type="button" onClick={load}>{t("common.retry")}</button>
        </div>
      </div>
    );
  } else if (sorted.length === 0) {
    body = creatingForm ? null : <p className="modal-empty-message">{t("workspaces.empty")}</p>;
  } else {
    body = (
      <>
        <div
          className="workspace-list"
          aria-label={t("workspaces.title")}
          onCompositionStart={listComposing.handlers.onCompositionStart}
          onCompositionEnd={listComposing.handlers.onCompositionEnd}
          {...listboxProps}
          onKeyDown={onListKeyDown}
        >
          {sorted.map((ws) => {
            const editing = editingId === ws.id;
            const rowProps = getRowProps(ws.id);
            return (
              <div
                key={ws.id}
                className={`workspace-item${ws.id === activeId ? " active" : ""}`}
                {...rowProps}
                // While renaming, the row is not a selection target — the edit
                // field owns it.
                onClick={editing ? undefined : rowProps.onClick}
                onDoubleClick={editing ? undefined : () => handleOpen(ws.id)}
              >
                {editing ? (
                  <div className="workspace-edit-stack" onClick={(e) => e.stopPropagation()}>
                    <div className="workspace-edit-row">
                      <input
                        className="form-input"
                        aria-label={t("workspaces.name")}
                        value={editName}
                        onChange={(e) => { setRenameError(null); setEditName(e.target.value); }}
                        onCompositionStart={renameComposing.handlers.onCompositionStart}
                        onCompositionEnd={renameComposing.handlers.onCompositionEnd}
                        onKeyDown={(e) => {
                          // Keep navigation keys out of the listbox while editing.
                          e.stopPropagation();
                          if (isComposingKeyboardEvent(renameComposing.composingRef, e)) return;
                          if (e.key === "Enter") void handleRename(ws.id);
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
                        onClick={() => void handleRename(ws.id)}
                        disabled={!editName.trim() || renamingId === ws.id || storagePending}
                      >
                        {renamingId === ws.id ? t("common.saving") : t("common.save")}
                      </button>
                    </div>
                    {renameError?.id === ws.id && (
                      <OperationalResult severity="error" className="modal-result workspace-rename-result">{text(renameError.message)}</OperationalResult>
                    )}
                  </div>
                ) : (
                  // One line each, so every row keeps its height: the name keeps
                  // its beginning and the folder its last segment. Hovering
                  // either shows it whole, and Rename's field holds the whole name.
                  <div className="workspace-item-main">
                    <div className="workspace-item-name">
                      <span className="workspace-item-name-text" title={ws.name}>{ws.name}</span>
                      {ws.id === activeWorkspaceId && <span className="workspace-item-current">{t("workspaces.current")}</span>}
                    </div>
                    <ShortPath className="workspace-item-dir" path={ws.dataDirectory} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="workspace-row-actions">
          <button className="btn-toolbar" disabled={rowActionsDisabled} onClick={() => selected && startRename(selected)}>
            {t("common.rename")}
          </button>
          <button className="btn-toolbar btn-delete" disabled={rowActionsDisabled} onClick={() => selected && handleDelete(selected)}>
            {t("workspaces.remove")}
          </button>
        </div>
      </>
    );
  }

  const listed = !loading && !listError && sorted.length > 0;

  return (
    <ModalShell
      title={t(firstRun ? "setup.title" : "workspaces.title")}
      onClose={handleRequestClose}
      width={560}
      maxHeight="85vh"
      closeOnBackdrop={dismissable}
      showClose={dismissable}
      closeDisabled={mutationBusy && !storagePending}
    >
      {!loading && !listError && (
        <div className="workspace-toolbar">
          {!creatingForm && (
            <button className="btn-toolbar" disabled={mutationBusy || storagePending} onClick={() => openCreateForm("")}>
              {t("workspaces.new")}
            </button>
          )}
          <button className="btn-toolbar" disabled={mutationBusy || storagePending} onClick={() => void handleAddExisting()}>
            {adding ? t("workspaces.opening") : t("workspaces.addExisting")}
          </button>
        </div>
      )}
      <div className="modal-body">
        <StoragePendingNotice />
        {removalWarnings.map((warning) => (
          <OperationalResult
            key={warning.id}
            severity="warning"
            className="modal-result"
            onDismiss={() => setRemovalWarnings((warnings) => warnings.filter((item) => item.id !== warning.id))}
          >{text(warning.message)}</OperationalResult>
        ))}
        {body}
        {creatingForm && createForm}
        {addError && (
          <OperationalResult severity="error" className="modal-result" onDismiss={() => setAddError(null)}>
            {text(addError)}
          </OperationalResult>
        )}
      </div>
      <div className="modal-footer">
        {creatingForm ? (
          <>
            {listed && (
              <button className="btn-action" disabled={creating && !storagePending} onClick={handleRequestClose}>
                {t("common.cancel")}
              </button>
            )}
            <button
              className="btn-primary"
              onClick={() => void handleCreate()}
              disabled={!createName.trim() || !(chosenLocation ?? suggestedLocation) || mutationBusy || storagePending}
            >
              {creating ? t("workspaces.creating") : t("workspaces.create")}
            </button>
          </>
        ) : (
          <>
            {dismissable && (
              <button className="btn-action" onClick={handleRequestClose} disabled={mutationBusy && !storagePending}>
                {t(mutationBusy && storagePending ? "common.close" : "common.cancel")}
              </button>
            )}
            {listed && (
              <button
                className="btn-primary"
                onClick={() => handleOpen(selectedId)}
                disabled={!selected || mutationBusy || storagePending || editingId !== null}
              >
                {t("workspaces.open")}
              </button>
            )}
          </>
        )}
      </div>
    </ModalShell>
  );
}
