import { AiAnalysisTab } from "./AiAnalysisTab";
import { AssetsTab } from "./AssetsTab";
import { PreviewTab } from "./PreviewTab";
import { MetadataTab } from "./MetadataTab";
import type { Post, PostFrontMatter, Target } from "../types";

export const RIGHT_TABS = ["AI Analysis", "Assets", "Preview", "Metadata"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

interface RightPaneProps {
  content: string;
  postId: string;
  frontMatter: PostFrontMatter | null;
  target: Target | null;
  extraFieldWatermark: string;
  onMetadataSaved: () => void;
  onFrontMatterUpdated: (post: Post) => void;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
  analysisTrigger: number;
  onInsertAtCursor: (text: string) => void;
  maxUploadMb: number;
}

export function RightPane({
  content,
  postId,
  frontMatter,
  target,
  extraFieldWatermark,
  onMetadataSaved,
  onFrontMatterUpdated,
  activeTab,
  onTabChange,
  analysisTrigger,
  onInsertAtCursor,
  maxUploadMb,
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
        <div className={activeTab === "AI Analysis" ? "" : "tab-hidden"}>
          <AiAnalysisTab postId={postId} content={content} analysisTrigger={analysisTrigger} />
        </div>
        <div className={activeTab === "Preview" ? "" : "tab-hidden"}>
          <PreviewTab content={content} postId={postId} />
        </div>
        <div className={activeTab === "Metadata" ? "" : "tab-hidden"}>
          {frontMatter && (
            <MetadataTab
              postId={postId}
              frontMatter={frontMatter}
              target={target}
              content={content}
              extraFieldWatermark={extraFieldWatermark}
              onMetadataSaved={onMetadataSaved}
              onFrontMatterUpdated={onFrontMatterUpdated}
            />
          )}
        </div>
        <div className={activeTab === "Assets" ? "" : "tab-hidden"}>
          <AssetsTab postId={postId} onInsertAtCursor={onInsertAtCursor} maxUploadMb={maxUploadMb} />
        </div>
      </div>
    </div>
  );
}
