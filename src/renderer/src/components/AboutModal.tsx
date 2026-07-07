import { ModalShell } from "./ModalShell";

interface AboutModalProps {
  onClose: () => void;
}

const GITHUB_URL = "https://github.com/nao7sep/bigmouth";

export function AboutModal({ onClose }: AboutModalProps) {
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
            style={{ fontSize: 13, color: "var(--bm-link)", textDecoration: "none" }}
          >
            GitHub ↗
          </a>
          <a
            href={`${GITHUB_URL}/issues`}
            target="_blank"
            rel="noreferrer"
            style={{ fontSize: 13, color: "var(--bm-link)", textDecoration: "none" }}
          >
            Report Issue ↗
          </a>
        </div>
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
