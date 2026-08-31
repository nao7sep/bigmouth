import type { ReactNode } from "react";
import { ErrorIcon, WarningIcon, XIcon } from "./Icon";

interface OperationalResultProps {
  severity: "warning" | "error";
  className: string;
  children: ReactNode;
  onDismiss?: () => void;
  dismissClassName?: string;
}

/**
 * The common semantics for persistent local operational results. Placement and
 * recovery remain owned by the feature surface; this supplies the visible
 * non-colour cue, live-region role, and accessible dismissal shared by them.
 */
export function OperationalResult({
  severity,
  className,
  children,
  onDismiss,
  dismissClassName,
}: OperationalResultProps) {
  const label = severity === "error" ? "Error" : "Warning";

  return (
    <div className={className} role={severity === "error" ? "alert" : "status"} aria-atomic="true">
      <span className="operational-result-message">
        {severity === "error" ? <ErrorIcon /> : <WarningIcon />}
        <strong>{label}:</strong> {children}
      </span>
      {onDismiss && (
        <button
          type="button"
          className={dismissClassName}
          onClick={onDismiss}
          aria-label={`Dismiss ${severity}`}
        >
          <XIcon />
        </button>
      )}
    </div>
  );
}
