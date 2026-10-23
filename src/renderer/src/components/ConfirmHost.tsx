import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ConfirmModal } from "./ConfirmModal";
import { presentFailure } from "../util/presentFailure";
import { message, type Message } from "@shared/i18n/translate";
import { useStoragePendingFor, useStorageScopeIdentity, useStorageResultReporter } from "../StoragePending";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  failureMessage?: Message;
  // Optional async action run when the user clicks confirm. If it rejects, the
  // dialog STAYS OPEN and shows the error (busy while running); the returned
  // promise resolves true only once it succeeds. Without it, confirm resolves
  // true immediately on confirm.
  onConfirm?: () => void | Promise<void>;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;
type ScopedConfirmFn = (options: ConfirmOptions, workspaceId: string | null) => Promise<boolean>;

// A queued request: the options plus the resolver of the promise handed back to
// the caller of confirm(). The promise always settles — confirm resolves true,
// cancel/Escape/backdrop resolve false.
interface ConfirmRequest extends ConfirmOptions {
  workspaceId: string | null;
  resolve: (result: boolean) => void;
}

const ConfirmContext = createContext<ScopedConfirmFn | null>(null);

/**
 * The single, app-wide promise-based confirm host. `confirm(opts)` enqueues a
 * request and returns a Promise<boolean>; only the head of the queue is rendered
 * as a ConfirmModal. Rendered after its children, so the dialog mounts last and
 * is therefore the topmost layer in the modal stack and paints on top.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const reportStorageResult = useStorageResultReporter();
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  // Guards against a double-click on Confirm firing onConfirm twice while the
  // first run is still in flight (React state updates are async).
  const runningRef = useRef(false);

  // The live queue, mirrored to a ref so the unmount cleanup can settle whatever
  // is still pending without re-subscribing on every queue change.
  const queueRef = useRef<ConfirmRequest[]>([]);
  useEffect(
    () => () => {
      // On teardown (host unmount / app quit / OS shutdown) every pending dialog
      // promise must settle, through the cancel path, so no caller is left
      // awaiting forever (modal-dialog-conventions: promises always settle).
      for (const request of queueRef.current) request.resolve(false);
      queueRef.current = [];
    },
    [],
  );

  const confirm = useCallback<ScopedConfirmFn>((options, workspaceId) => {
    return new Promise<boolean>((resolve) => {
      const next = [...queueRef.current, { ...options, workspaceId, resolve }];
      queueRef.current = next;
      setQueue(next);
    });
  }, []);

  // Drop the head request and reset the per-request busy/error state for the
  // next one in the queue.
  const dequeue = useCallback(() => {
    setBusy(false);
    setError(null);
    runningRef.current = false;
    const next = queueRef.current.slice(1);
    queueRef.current = next;
    setQueue(next);
  }, []);

  const head = queue[0];
  const storagePending = useStoragePendingFor(head?.workspaceId ?? null);

  const handleConfirm = useCallback(() => {
    const request = head;
    if (!request || queueRef.current[0] !== request || runningRef.current || (storagePending && request.onConfirm)) return;

    if (!request.onConfirm) {
      request.resolve(true);
      dequeue();
      return;
    }

    runningRef.current = true;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await request.onConfirm!();
        if (queueRef.current[0] !== request) return;
        request.resolve(true);
        dequeue();
      } catch (err) {
        // The action failed: keep the dialog open, surface the reason, and clear
        // busy so the user can retry or cancel. The promise stays unsettled.
        const stillShown = queueRef.current[0] === request;
        const failure = presentFailure(request.failureMessage ?? message(stillShown ? "confirm.failed" : "app.storageChangeFailed"), "renderer: confirmed action failed", err);
        if (!stillShown) { reportStorageResult(failure); return; }
        setError(failure);
        setBusy(false);
        runningRef.current = false;
      }
    })();
  }, [head, dequeue, reportStorageResult, storagePending]);

  const handleCancel = useCallback(() => {
    const request = head;
    if (!request || queueRef.current[0] !== request || (runningRef.current && !storagePending)) return;
    request.resolve(false);
    dequeue();
  }, [head, dequeue, storagePending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {head && (
        <ConfirmModal
          title={head.title}
          message={head.message}
          confirmLabel={head.confirmLabel}
          cancelLabel={head.cancelLabel}
          danger={head.danger}
          busy={busy}
          pending={storagePending && Boolean(head.onConfirm)}
          error={error}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/** Returns the app-wide `confirm` function. Must be called under a ConfirmProvider. */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  const workspaceId = useStorageScopeIdentity();
  if (!confirm) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return useCallback((options: ConfirmOptions) => confirm(options, workspaceId), [confirm, workspaceId]);
}
