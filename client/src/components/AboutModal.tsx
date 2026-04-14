import { useEscapeKey } from "../hooks/useEscapeKey";

interface AboutModalProps {
  onClose: () => void;
}

const GITHUB_URL = "https://github.com/nao7sep/bigmouth";

export function AboutModal({ onClose }: AboutModalProps) {
  useEscapeKey(onClose);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ width: 380 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>About BigMouth</h2>
          <button className="modal-close" onClick={onClose} autoFocus>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: 4 }}>
            <strong>BigMouth</strong> — Version 0.1.0
          </p>
          <p style={{ marginTop: 8, fontSize: 13, color: "#555", lineHeight: 1.6 }}>
            A local-first writing preflight tool for composing blog and social media posts.
            Your data stays on your machine.
          </p>
          <div style={{ marginTop: 16, display: "flex", gap: 16 }}>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, color: "#0066cc", textDecoration: "none" }}
            >
              GitHub ↗
            </a>
            <a
              href={`${GITHUB_URL}/issues`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13, color: "#0066cc", textDecoration: "none" }}
            >
              Report Issue ↗
            </a>
          </div>
          <p style={{ marginTop: 16, fontSize: 12, color: "#aaa" }}>
            &copy; 2026 Yoshinao Inoguchi &mdash; MIT License
          </p>
        </div>
      </div>
    </div>
  );
}
