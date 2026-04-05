export function CenterPane() {
  return (
    <div className="pane-center">
      <div className="center-toolbar">
        <span>Target</span>
        <span>|</span>
        <span>Language</span>
        <span>|</span>
        <span>Status: draft</span>
      </div>
      <div className="center-editor">
        <textarea
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            outline: "none",
            resize: "none",
            fontFamily: "inherit",
            fontSize: 14,
          }}
          placeholder="Select a post to start editing..."
        />
      </div>
      <div className="center-counts">
        <span>0 characters</span>
        <span>0 paragraphs</span>
      </div>
    </div>
  );
}
