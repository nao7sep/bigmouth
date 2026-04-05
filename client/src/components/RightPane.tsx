import { useState } from "react";

const TABS = ["AI Analysis", "Assets", "Preview", "Metadata"] as const;

export function RightPane() {
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
        <p style={{ color: "#999" }}>{activeTab} — coming soon</p>
      </div>
    </div>
  );
}
