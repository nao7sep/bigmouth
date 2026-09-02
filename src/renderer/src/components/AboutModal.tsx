import { useRef, useState } from "react";
import { openExternal, reportProblem } from "../api";
import { ModalShell } from "./ModalShell";
import { ExternalLinkIcon } from "./Icon";
import { OperationalResult } from "./OperationalResult";

interface AboutModalProps {
  onClose: () => void;
}

const GITHUB_URL = "https://github.com/nao7sep/bigmouth";

export function AboutModal({ onClose }: AboutModalProps) {
  const [linkFailures, setLinkFailures] = useState<Record<"repo" | "issues", string | undefined>>({
    repo: undefined,
    issues: undefined,
  });
  const linkAttempts = useRef<Record<"repo" | "issues", number>>({ repo: 0, issues: 0 });

  async function openLink(owner: "repo" | "issues", url: string): Promise<void> {
    const attempt = ++linkAttempts.current[owner];
    try {
      await openExternal(url);
      if (linkAttempts.current[owner] !== attempt) return;
      setLinkFailures((current) => ({ ...current, [owner]: undefined }));
    } catch (error) {
      reportProblem("About link could not be opened", error, { owner, url });
      if (linkAttempts.current[owner] !== attempt) return;
      setLinkFailures((current) => ({
        ...current,
        [owner]: owner === "repo"
          ? "GitHub could not be opened. Try again."
          : "Report Issue could not be opened. Try again.",
      }));
    }
  }

  const dismissFailure = (owner: "repo" | "issues"): void => {
    setLinkFailures((current) => ({ ...current, [owner]: undefined }));
  };

  return (
    <ModalShell title="About BigMouth" onClose={onClose} width={380} autoFocusClose>
      <div className="modal-body">
        <p style={{ marginBottom: 4 }}>
          <strong>BigMouth</strong> — Version {__APP_VERSION__}
        </p>
        <p style={{ marginTop: 8, fontSize: 13, color: "var(--bm-text-soft)", lineHeight: 1.6 }}>
          A local-first writing preflight tool for composing blog and social media posts.
          Your data stays on your machine.
        </p>
        <div style={{ marginTop: 16, display: "flex", gap: 16 }}>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => { event.preventDefault(); void openLink("repo", GITHUB_URL); }}
            style={{ fontSize: 13, color: "var(--bm-link)", textDecoration: "none", whiteSpace: "nowrap" }}
          >
            GitHub <ExternalLinkIcon />
          </a>
          <a
            href={`${GITHUB_URL}/issues`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => { event.preventDefault(); void openLink("issues", `${GITHUB_URL}/issues`); }}
            style={{ fontSize: 13, color: "var(--bm-link)", textDecoration: "none", whiteSpace: "nowrap" }}
          >
            Report Issue <ExternalLinkIcon />
          </a>
        </div>
        {linkFailures.repo ? (
          <OperationalResult severity="error" className="modal-result" onDismiss={() => dismissFailure("repo")}>
            {linkFailures.repo}
          </OperationalResult>
        ) : null}
        {linkFailures.issues ? (
          <OperationalResult severity="error" className="modal-result" onDismiss={() => dismissFailure("issues")}>
            {linkFailures.issues}
          </OperationalResult>
        ) : null}
        <p style={{ marginTop: 16, fontSize: 12, color: "var(--bm-text-faint)" }}>
          &copy; 2026 Yoshinao Inoguchi &mdash; MIT License
        </p>
      </div>
      <div className="modal-footer">
        <button className="btn-toolbar" onClick={onClose}>
          Close
        </button>
      </div>
    </ModalShell>
  );
}
