interface AboutModalProps {
  onClose: () => void;
}

export function AboutModal({ onClose }: AboutModalProps) {
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
          <p style={{ marginBottom: 12 }}>
            <strong>BigMouth</strong> is a local-first writing preflight tool
            for composing blog and social media posts.
          </p>
          <ul style={{ paddingLeft: "1.5em", lineHeight: 1.8, fontSize: 13 }}>
            <li>Write and edit posts in Markdown</li>
            <li>Run AI-powered safety and quality checks</li>
            <li>Generate titles, tags, slugs, and SEO descriptions</li>
            <li>Export as HTML or plain text</li>
          </ul>
          <p
            style={{
              marginTop: 16,
              fontSize: 12,
              color: "#888",
              borderTop: "1px solid #e0e0e0",
              paddingTop: 12,
            }}
          >
            All data is stored locally. BigMouth never syncs with any platform —
            you copy and paste your content manually.
          </p>
        </div>
      </div>
    </div>
  );
}
