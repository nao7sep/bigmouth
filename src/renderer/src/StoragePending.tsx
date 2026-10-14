import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getStoragePending, onStoragePendingChanged, reportProblem } from "./api";
import { OperationalResult } from "./components/OperationalResult";
import { ListedMessageView, type ListedMessage } from "./components/NamedItems";
import { useI18n } from "./i18n/I18nContext";
import type { Message } from "@shared/i18n/translate";

// A result about several items arrives as one ListedMessage — a few names and
// the full list behind a disclosure — never as one result per item.
type ResultReporter = (message: Message | ListedMessage, severity?: "warning" | "error") => void;
type StorageResult = { id: number; listed: ListedMessage; severity: "warning" | "error" };
export const StoragePendingContext = createContext(false);
const StorageResultContext = createContext<ResultReporter>(() => {});
const StorageResultsContext = createContext<{ results: StorageResult[]; dismiss: (id: number) => void }>({ results: [], dismiss: () => {} });

/** A slow started change still belongs to storage until its actual result arrives. */
export function StoragePendingProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState(false);
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
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const off = onStoragePendingChanged((next) => {
      if (!active) return;
      receivedEvent = true;
      setPending(next);
    });
    void getStoragePending().then((initial) => {
      if (active && !receivedEvent) setPending(initial);
    }).catch((error: unknown) => reportProblem("renderer: pending storage state could not be read", error));
    return () => { active = false; off(); };
  }, []);
  return <StoragePendingContext.Provider value={pending}>
    <StorageResultContext.Provider value={report}>
      <StorageResultsContext.Provider value={{ results, dismiss }}>{children}</StorageResultsContext.Provider>
    </StorageResultContext.Provider>
  </StoragePendingContext.Provider>;
}

export function useStoragePending(): boolean { return useContext(StoragePendingContext); }
export function useStorageResultReporter(): ResultReporter { return useContext(StorageResultContext); }

export function StoragePendingNotice({ className = "modal-result" }: { className?: string }) {
  const pending = useStoragePending();
  const { t } = useI18n();
  return pending ? <OperationalResult severity="warning" className={className}>{t("app.storagePending")}</OperationalResult> : null;
}

export function StoragePendingResults() {
  const { results, dismiss } = useContext(StorageResultsContext);
  return results.map((result) => <OperationalResult key={result.id} severity={result.severity}
    className="app-operational-result" onDismiss={() => dismiss(result.id)}><ListedMessageView listed={result.listed} /></OperationalResult>);
}
