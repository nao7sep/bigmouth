import { PreviewTab } from "./PreviewTab";
import { MetadataTab } from "./MetadataTab";
import type { PostFrontMatter, Target } from "../types";

export const RIGHT_TABS = ["AI Analysis", "Assets", "Preview", "Metadata"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

interface RightPaneProps {
  content: string;
  postId: string;
  frontMatter: PostFrontMatter | null;
  target: Target | null;
  extraFieldWatermark: string;
  onMetadataSaved: () => void;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
}

export function RightPane({
  content,
  postId,
  frontMatter,
  target,
  extraFieldWatermark,
  onMetadataSaved,
  activeTab,
  onTabChange,
}: RightPaneProps) {

  return (
    <div className="pane-right">
      <div className="right-tabs">
        {RIGHT_TABS.map((tab) => (
          <button
            key={tab}
            className={`right-tab${activeTab === tab ? " active" : ""}`}
            onClick={() => onTabChange(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="right-content">
        {activeTab === "Preview" && (
          <PreviewTab content={content} postId={postId} />
        )}
        {activeTab === "Metadata" && frontMatter && (
          <MetadataTab
            postId={postId}
            frontMatter={frontMatter}
            target={target}
            extraFieldWatermark={extraFieldWatermark}
            onMetadataSaved={onMetadataSaved}
          />
        )}
        {activeTab !== "Preview" && activeTab !== "Metadata" && (
          <p style={{ color: "#999" }}>{activeTab} — coming soon</p>
        )}
      </div>
    </div>
  );
}
