import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { getUiState, reportProblem } from "./api";
import { denyUnhandledExternalDrop } from "./util/externalDropBoundary";
import { installWindowActivityState } from "./windowActivity";
import { InterfaceLanguageRoot } from "./i18n/InterfaceLanguageRoot";
import { RecordsWindow } from "./records/RecordsWindow";
import { clamp } from "./paneConstants";
import type { InterfaceLanguage } from "@shared/i18n/languages";
import { loadCatalogue } from "@shared/i18n/catalogues";
import { RECORDS_LIST_WIDTH } from "@shared/layout";
import "./App.css";

// The records window's page: the same guards and last-resort hooks as the main
// window's (main.tsx), around the records window.
window.addEventListener("dragover", denyUnhandledExternalDrop);
window.addEventListener("drop", denyUnhandledExternalDrop);

installWindowActivityState(window.bigmouth.onWindowActivityChanged, document.documentElement);

window.addEventListener("error", (event) => {
  reportProblem("renderer: uncaught error", event.error ?? event.message, {
    source: event.filename,
    line: event.lineno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  reportProblem("renderer: unhandled promise rejection", event.reason);
});

async function interfaceLanguage(): Promise<InterfaceLanguage> {
  try {
    const language = await window.bigmouth.getInterfaceLanguage();
    await loadCatalogue(language.language);
    return language;
  } catch (err) {
    reportProblem("renderer: interface language unavailable", err);
    return { language: "en", locale: "en" };
  }
}

// The list pane opens at its saved width, so the first frame already has it.
async function listWidth(): Promise<number> {
  try {
    const { recordsListWidth } = await getUiState();
    return clamp(recordsListWidth, RECORDS_LIST_WIDTH.min, RECORDS_LIST_WIDTH.max);
  } catch (err) {
    reportProblem("renderer: records list width read failed", err);
    return RECORDS_LIST_WIDTH.default;
  }
}

void Promise.all([interfaceLanguage(), listWidth()]).then(([initial, width]) => {
  document.documentElement.lang = initial.language;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <InterfaceLanguageRoot initial={initial}>
          <RecordsWindow initialListWidth={width} />
        </InterfaceLanguageRoot>
      </ErrorBoundary>
    </StrictMode>
  );
});
