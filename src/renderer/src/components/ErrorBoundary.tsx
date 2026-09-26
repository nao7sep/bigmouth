import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportProblem } from "../api";
import { documentTranslator } from "../i18n/I18nContext";

interface Props {
  children: ReactNode;
}

interface State { failed: boolean; }

/**
 * Catches a render-time error so the window shows what happened instead of a
 * blank page, and so the failure reaches the session log.
 *
 * Deliberately offers no "try again": whatever state produced the error is
 * still there, so re-rendering would fail the same way. The log file is the
 * actionable thing, and its location is where the About dialog already says.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(err: unknown, info: ErrorInfo): void {
    reportProblem("renderer: render failed", err, { componentStack: info.componentStack });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    // Outside the language provider, so it speaks what the document last declared.
    const { t } = documentTranslator();
    return (
      <div className="fatal-error" role="alert">
        <h1>{t("fatal.title")}</h1>
        <p>{t("fatal.detail")}</p>
      </div>
    );
  }
}
