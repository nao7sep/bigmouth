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
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: 4 }}>
            <strong>BigMouth</strong> — Version 0.1.0
          </p>
          <p style={{ marginBottom: 12, fontSize: 13, color: "#555" }}>
            A local-first writing preflight tool for composing blog and social
            media posts.
          </p>
          <ul style={{ paddingLeft: "1.5em", lineHeight: 1.8, fontSize: 13 }}>
            <li>Write in Markdown — autosaved as you type</li>
            <li>Three-stage workflow: Draft → Ready → Published</li>
            <li>AI-powered content analysis with named prompts</li>
            <li>AI metadata generation: title, slug, tags, SEO description</li>
            <li>Upload and embed images and files per post</li>
            <li>Export as HTML or plain text for copy-pasting</li>
            <li>Multi-language posts with English supplement fields</li>
          </ul>
          <p style={{ marginTop: 12, fontSize: 13, color: "#555" }}>
            All data is stored locally under <code>~/.bigmouth/</code>. BigMouth
            never syncs with any platform — you copy and paste manually.
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
