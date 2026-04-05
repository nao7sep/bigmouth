import { AiAnalysisTab } from "./AiAnalysisTab";
import { AssetsTab } from "./AssetsTab";
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
  analysisTrigger: number;
  onInsertAtCursor: (text: string) => void;
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
  analysisTrigger,
  onInsertAtCursor,
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
        {activeTab === "AI Analysis" && (
          <AiAnalysisTab postId={postId} analysisTrigger={analysisTrigger} />
        )}
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
        {activeTab === "Assets" && (
          <AssetsTab postId={postId} onInsertAtCursor={onInsertAtCursor} />
        )}
      </div>
    </div>
  );
}
