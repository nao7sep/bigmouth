import type { ReactNode } from "react";
import { XIcon } from "./Icon";

interface OperationalResultProps {
  severity: "warning" | "error";
  className: string;
  children: ReactNode;
  onDismiss?: () => void;
  dismissClassName?: string;
}

/**
 * The common semantics for persistent local operational results. Placement and
 * recovery remain owned by the feature surface; this supplies live-region
 * semantics and the quiet, upper-end dismissal shared by them.
 */
export function OperationalResult({
  severity,
  className,
  children,
  onDismiss,
  dismissClassName,
}: OperationalResultProps) {
  return (
    <div
      className={`${className} operational-result operational-result--${severity}`}
      role={severity === "error" ? "alert" : "status"}
      aria-atomic="true"
    >
      <div className="operational-result-message">{children}</div>
      {onDismiss && (
        <button
          type="button"
          className={`operational-result-dismiss${dismissClassName ? ` ${dismissClassName}` : ""}`}
          onClick={onDismiss}
          aria-label="Close result"
        >
          <XIcon />
        </button>
      )}
    </div>
  );
}
