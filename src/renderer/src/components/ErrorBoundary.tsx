import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportProblem } from "../api";

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
    return (
      <div className="fatal-error" role="alert">
        <h1>BigMouth hit an error it could not recover from</h1>
        <p>
          Your posts are on disk and unaffected. Restart the app; the session log has the
          details.
        </p>
      </div>
    );
  }
}
