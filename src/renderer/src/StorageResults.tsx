import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { OperationalResult } from "./components/OperationalResult";
import { ListedMessageView, type ListedMessage } from "./components/NamedItems";
import type { Message } from "@shared/i18n/translate";

// A result about several items arrives as one ListedMessage — a few names and
// the full list behind a disclosure — never as one result per item.
type ResultReporter = (message: Message | ListedMessage, severity?: "warning" | "error") => void;
type StorageResult = { id: number; listed: ListedMessage; severity: "warning" | "error" };
const StorageResultContext = createContext<ResultReporter>(() => {});
const StorageResultsContext = createContext<{ results: StorageResult[]; dismiss: (id: number) => void }>({ results: [], dismiss: () => {} });

/**
 * Results of storage changes whose view has gone: a departed editor cannot
 * present a later failure, so the app shell keeps those outcomes until
 * dismissed. This is no retry or durable job owner.
 */
export function StorageResultsProvider({ children }: { children: ReactNode }) {
  const [results, setResults] = useState<StorageResult[]>([]);
  const nextResult = useRef(0);
  const report = useCallback<ResultReporter>((message, severity = "error") => {
    const id = ++nextResult.current;
    const listed = "key" in message ? { message } : message;
    setResults((current) => [...current, { id, listed, severity }]);
  }, []);
  const dismiss = useCallback((id: number) => setResults((current) => current.filter((result) => result.id !== id)), []);
  return <StorageResultContext.Provider value={report}>
    <StorageResultsContext.Provider value={{ results, dismiss }}>{children}</StorageResultsContext.Provider>
  </StorageResultContext.Provider>;
}

export function useStorageResultReporter(): ResultReporter { return useContext(StorageResultContext); }

export function StorageResults() {
  const { results, dismiss } = useContext(StorageResultsContext);
  return results.map((result) => <OperationalResult key={result.id} severity={result.severity}
    className="app-operational-result" onDismiss={() => dismiss(result.id)}><ListedMessageView listed={result.listed} /></OperationalResult>);
}
