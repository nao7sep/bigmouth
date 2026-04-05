import { useState } from "react";
import { PreviewTab } from "./PreviewTab";

const TABS = ["AI Analysis", "Assets", "Preview", "Metadata"] as const;

interface RightPaneProps {
  content: string;
  postId: string;
}

export function RightPane({ content, postId }: RightPaneProps) {
  const [activeTab, setActiveTab] = useState<string>("AI Analysis");

  return (
    <div className="pane-right">
      <div className="right-tabs">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`right-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="right-content">
        {activeTab === "Preview" ? (
          <PreviewTab content={content} postId={postId} />
        ) : (
          <p style={{ color: "#999" }}>{activeTab} — coming soon</p>
        )}
      </div>
    </div>
  );
}
