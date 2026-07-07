import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ConfirmModal } from "./ConfirmModal";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  // Optional async action run when the user clicks confirm. If it rejects, the
  // dialog STAYS OPEN and shows the error (busy while running); the returned
  // promise resolves true only once it succeeds. Without it, confirm resolves
  // true immediately on confirm.
  onConfirm?: () => void | Promise<void>;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

// A queued request: the options plus the resolver of the promise handed back to
// the caller of confirm(). The promise always settles — confirm resolves true,
// cancel/Escape/backdrop resolve false.
interface ConfirmRequest extends ConfirmOptions {
  resolve: (result: boolean) => void;
}

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * The single, app-wide promise-based confirm host. `confirm(opts)` enqueues a
 * request and returns a Promise<boolean>; only the head of the queue is rendered
 * as a ConfirmModal. Rendered after its children, so the dialog mounts last and
 * is therefore the topmost layer in the modal stack and paints on top.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<ConfirmRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a double-click on Confirm firing onConfirm twice while the
  // first run is still in flight (React state updates are async).
  const runningRef = useRef(false);

  // The live queue, mirrored to a ref so the unmount cleanup can settle whatever
  // is still pending without re-subscribing on every queue change.
  const queueRef = useRef<ConfirmRequest[]>([]);
  queueRef.current = queue;
  useEffect(
    () => () => {
      // On teardown (host unmount / app quit / OS shutdown) every pending dialog
      // promise must settle, through the cancel path, so no caller is left
      // awaiting forever (modal-dialog-conventions: promises always settle).
      for (const request of queueRef.current) request.resolve(false);
    },
    [],
  );

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      setQueue((current) => [...current, { ...options, resolve }]);
    });
  }, []);

  // Drop the head request and reset the per-request busy/error state for the
  // next one in the queue.
  const dequeue = useCallback(() => {
    setBusy(false);
    setError(null);
    runningRef.current = false;
    setQueue((current) => current.slice(1));
  }, []);

  const head = queue[0];

  const handleConfirm = useCallback(() => {
    const request = head;
    if (!request || runningRef.current) return;

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
        request.resolve(true);
        dequeue();
      } catch (err) {
        // The action failed: keep the dialog open, surface the reason, and clear
        // busy so the user can retry or cancel. The promise stays unsettled.
        setError(err instanceof Error ? err.message : "Action failed.");
        setBusy(false);
        runningRef.current = false;
      }
    })();
  }, [head, dequeue]);

  const handleCancel = useCallback(() => {
    const request = head;
    if (!request || runningRef.current) return;
    request.resolve(false);
    dequeue();
  }, [head, dequeue]);

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
  if (!confirm) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return confirm;
}
