import { useState } from "react";

export function LeftPane() {
  const [draftsOpen, setDraftsOpen] = useState(true);
  const [readyOpen, setReadyOpen] = useState(true);
  const [publishedOpen, setPublishedOpen] = useState(false);

  return (
    <div className="pane-left">
      <div className="left-header">
        <h1>
          BigMouth
          <button className="btn-hamburger" title="Menu">
            &#9776;
          </button>
        </h1>
        <button className="btn-new-post">+ New Post</button>
        <input
          className="search-box"
          type="text"
          placeholder="Search posts..."
        />
      </div>

      <div className="left-sections">
        <div
          className="section-header"
          onClick={() => setDraftsOpen(!draftsOpen)}
        >
          <span>{draftsOpen ? "\u25BC" : "\u25B6"} Drafts</span>
          <span className="section-count">0</span>
        </div>
        {draftsOpen && (
          <div className="section-items">
            <div style={{ padding: "12px 16px", color: "#999", fontSize: 13 }}>
              No drafts
            </div>
          </div>
        )}

        <div
          className="section-header"
          onClick={() => setReadyOpen(!readyOpen)}
        >
          <span>{readyOpen ? "\u25BC" : "\u25B6"} Ready</span>
          <span className="section-count">0</span>
        </div>
        {readyOpen && (
          <div className="section-items">
            <div style={{ padding: "12px 16px", color: "#999", fontSize: 13 }}>
              No ready posts
            </div>
          </div>
        )}

        <div
          className="section-header"
          onClick={() => setPublishedOpen(!publishedOpen)}
        >
          <span>{publishedOpen ? "\u25BC" : "\u25B6"} Published</span>
          <span className="section-count">0</span>
        </div>
        {publishedOpen && (
          <div className="section-items">
            <div style={{ padding: "12px 16px", color: "#999", fontSize: 13 }}>
              No published posts
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
