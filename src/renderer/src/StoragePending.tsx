import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getStoragePending, onStoragePendingChanged, getDurabilityUnconfirmed, onDurabilityUnconfirmed, reportProblem } from "./api";
import { OperationalResult } from "./components/OperationalResult";
import { ListedMessageView, type ListedMessage } from "./components/NamedItems";
import { useI18n } from "./i18n/I18nContext";
import type { Message } from "@shared/i18n/translate";

// A result about several items arrives as one ListedMessage — a few names and
// the full list behind a disclosure — never as one result per item.
type ResultReporter = (message: Message | ListedMessage, severity?: "warning" | "error") => void;
type StorageResult = { id: number; listed: ListedMessage; severity: "warning" | "error" };
export const StoragePendingContext = createContext(false);
const StorageScopeContext = createContext<string | null>(null);
const DurabilityContext = createContext(false);
const StorageResultContext = createContext<ResultReporter>(() => {});
const StorageResultsContext = createContext<{ results: StorageResult[]; dismiss: (id: number) => void }>({ results: [], dismiss: () => {} });

/** A slow started change still belongs to storage until its actual result arrives. */
export function StoragePendingProvider({ children }: { children: ReactNode }) {
  const pending = useStoragePendingFor(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  useEffect(() => {
    let active = true;
    const off = onDurabilityUnconfirmed(() => { if (active) setUnconfirmed(true); });
    void getDurabilityUnconfirmed().then(value => { if (active && value) setUnconfirmed(true); })
      .catch(error => reportProblem("renderer: durability status could not be read", error));
    return () => { active = false; off(); };
  }, []);

  // A departed editor cannot present a later failure. Keep only those outcomes
  // in the app shell until dismissed; this is no retry or durable job owner.
  const [results, setResults] = useState<StorageResult[]>([]);
  const nextResult = useRef(0);
  const report = useCallback<ResultReporter>((message, severity = "error") => {
    const id = ++nextResult.current;
    const listed = "key" in message ? { message } : message;
    setResults((current) => [...current, { id, listed, severity }]);
  }, []);
  const dismiss = useCallback((id: number) => setResults((current) => current.filter((result) => result.id !== id)), []);
  return <StorageScopeContext.Provider value={null}><StoragePendingContext.Provider value={pending}>
    <StorageResultContext.Provider value={report}>
      <DurabilityContext.Provider value={unconfirmed}>
        <StorageResultsContext.Provider value={{ results, dismiss }}>{children}</StorageResultsContext.Provider>
      </DurabilityContext.Provider>
    </StorageResultContext.Provider>
  </StoragePendingContext.Provider></StorageScopeContext.Provider>;
}

/** Pending changes are queried for their owner; the broadcast only invalidates the query. */
export function useStoragePendingFor(workspaceId: string | null): boolean {
  const [snapshot, setSnapshot] = useState({ workspaceId, pending: false });
  useEffect(() => {
    let active = true;
    let generation = 0;
    setSnapshot({ workspaceId, pending: false });
    const read = () => {
      const request = ++generation;
      void getStoragePending(workspaceId).then((pending) => {
        if (active && generation === request) setSnapshot({ workspaceId, pending });
      }).catch((error: unknown) => {
        if (active && generation === request) reportProblem("renderer: pending storage state could not be read", error);
      });
    };
    const off = onStoragePendingChanged(read);
    read();
    return () => { active = false; off(); };
  }, [workspaceId]);
  return snapshot.workspaceId === workspaceId && snapshot.pending;
}

export function StoragePendingScope({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }) {
  const pending = useStoragePendingFor(workspaceId);
  return <StorageScopeContext.Provider value={workspaceId}>
    <StoragePendingContext.Provider value={pending}>{children}</StoragePendingContext.Provider>
  </StorageScopeContext.Provider>;
}

export function useStorageScopeIdentity(): string | null { return useContext(StorageScopeContext); }

export function useStoragePending(): boolean { return useContext(StoragePendingContext); }
export function useStorageResultReporter(): ResultReporter { return useContext(StorageResultContext); }

export function StoragePendingNotice({ className = "modal-result" }: { className?: string }) {
  const pending = useStoragePending();
  const unconfirmed = useContext(DurabilityContext);
  const { t } = useI18n();
  return <>
    {pending && <OperationalResult severity="warning" className={className}>{t("app.storagePending")}</OperationalResult>}
    {unconfirmed && <OperationalResult severity="warning" className={className}>{t("app.durabilityUnconfirmed")}</OperationalResult>}
  </>;
}

export function StoragePendingResults() {
  const { results, dismiss } = useContext(StorageResultsContext);
  return results.map((result) => <OperationalResult key={result.id} severity={result.severity}
    className="app-operational-result" onDismiss={() => dismiss(result.id)}><ListedMessageView listed={result.listed} /></OperationalResult>);
}
