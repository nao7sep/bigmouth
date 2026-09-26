import { useRef, useState } from "react";
import { openExternal, reportProblem } from "../api";
import { ModalShell } from "./ModalShell";
import { ExternalLinkIcon } from "./Icon";
import { OperationalResult } from "./OperationalResult";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "@shared/i18n/catalogues";

interface AboutModalProps {
  onClose: () => void;
}

const GITHUB_URL = "https://github.com/nao7sep/bigmouth";

export function AboutModal({ onClose }: AboutModalProps) {
  const { t } = useI18n();
  const [linkFailures, setLinkFailures] = useState<Record<"repo" | "issues", MessageKey | undefined>>({
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
        [owner]: owner === "repo" ? "about.repoFailed" : "about.issuesFailed",
      }));
    }
  }

  const dismissFailure = (owner: "repo" | "issues"): void => {
    setLinkFailures((current) => ({ ...current, [owner]: undefined }));
  };

  return (
    <ModalShell title={t("about.title")} titleHidden onClose={onClose} width={380} autoFocusClose>
      <div className="modal-body">
        <div className="about-identity">
          <p className="about-name">BigMouth</p>
          <p className="about-version">{t("about.version", { version: __APP_VERSION__ })}</p>
        </div>
        <p style={{ marginTop: 8, fontSize: 13, color: "var(--bm-text-soft)", lineHeight: 1.6 }}>
          {t("about.description")}
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
            {t("about.reportIssue")} <ExternalLinkIcon />
          </a>
        </div>
        {linkFailures.repo ? (
          <OperationalResult severity="error" className="modal-result" onDismiss={() => dismissFailure("repo")}>
            {t(linkFailures.repo)}
          </OperationalResult>
        ) : null}
        {linkFailures.issues ? (
          <OperationalResult severity="error" className="modal-result" onDismiss={() => dismissFailure("issues")}>
            {t(linkFailures.issues)}
          </OperationalResult>
        ) : null}
        <p style={{ marginTop: 16, fontSize: 12, color: "var(--bm-text-faint)" }}>
          {t("about.copyright")}
        </p>
      </div>
      <div className="modal-footer">
        <button className="btn-action" onClick={onClose}>
          {t("common.close")}
        </button>
      </div>
    </ModalShell>
  );
}
