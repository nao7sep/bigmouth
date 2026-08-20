import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfirmProvider } from "./components/ConfirmHost";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { reportProblem } from "./api";

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ErrorBoundary>
  </StrictMode>
);
