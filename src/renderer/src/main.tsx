import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfirmProvider } from "./components/ConfirmHost";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { reportProblem } from "./api";
import { denyUnhandledExternalDrop } from "./util/externalDropBoundary";
import { installWindowActivityState } from "./windowActivity";
import { InterfaceLanguageRoot } from "./i18n/InterfaceLanguageRoot";
import type { InterfaceLanguage } from "@shared/i18n/languages";

window.addEventListener("dragover", denyUnhandledExternalDrop);
window.addEventListener("drop", denyUnhandledExternalDrop);

installWindowActivityState(window.bigmouth.onWindowActivityChanged, document.documentElement);

// Last-resort hooks: anything that escapes a component or a promise chain lands
// in the session log instead of only the devtools console, which nobody has open
// when it matters (logging conventions, "Global last-resort hooks").
window.addEventListener("error", (event) => {
  reportProblem("renderer: uncaught error", event.error ?? event.message, {
    source: event.filename,
    line: event.lineno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  reportProblem("renderer: unhandled promise rejection", event.reason);
});

// No text until the language is known, so the first words on screen are
// already in it. English only if main cannot say, which leaves the window usable.
async function interfaceLanguage(): Promise<InterfaceLanguage> {
  try {
    return await window.bigmouth.getInterfaceLanguage();
  } catch (err) {
    reportProblem("renderer: interface language unavailable", err);
    return { language: "en", locale: "en" };
  }
}

void interfaceLanguage().then((initial) => {
  document.documentElement.lang = initial.language;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <InterfaceLanguageRoot initial={initial}>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </InterfaceLanguageRoot>
      </ErrorBoundary>
    </StrictMode>
  );
});
