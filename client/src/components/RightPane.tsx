import { forwardRef, useImperativeHandle, useRef } from "react";
import { AiAnalysisTab } from "./AiAnalysisTab";
import { ImagePromptsTab } from "./ImagePromptsTab";
import { AssetsTab } from "./AssetsTab";
import { PreviewTab } from "./PreviewTab";
import { MetadataTab, type MetadataTabHandle } from "./MetadataTab";
import type { Post, PostFrontMatter, Target } from "../types";

export const RIGHT_TABS = ["AI Analysis", "Image Prompts", "Assets", "Preview", "Metadata"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

interface RightPaneProps {
  workspaceId: string;
  content: string;
  postId: string;
  frontMatter: PostFrontMatter | null;
  target: Target | null;
  extraFieldWatermark: string;
  onPostUpdated: (post: Post) => void;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
  analysisTrigger: number;
  analysisPromptsVersion: number;
  onInsertAtCursor: (text: string) => void;
  maxUploadMb: number;
  loading?: boolean;
}

export interface RightPaneHandle {
  flushPendingChanges: () => Promise<boolean>;
}

export const RightPane = forwardRef<RightPaneHandle, RightPaneProps>(function RightPane(
  {
    workspaceId,
    content,
    postId,
    frontMatter,
    target,
    extraFieldWatermark,
    onPostUpdated,
    activeTab,
    onTabChange,
    analysisTrigger,
    analysisPromptsVersion,
    onInsertAtCursor,
    maxUploadMb,
    loading = false,
  },
  ref
) {
  const metadataRef = useRef<MetadataTabHandle>(null);
  const isPublished = frontMatter?.status === "published";

  useImperativeHandle(
    ref,
    () => ({
      flushPendingChanges: async () => (await metadataRef.current?.flushPendingChanges()) ?? true,
    }),
    []
  );

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
          {loading ? (
            <RightPanePlaceholder message="Loading post…" />
          ) : (
            <AiAnalysisTab
              postId={postId}
              content={content}
              analysisTrigger={analysisTrigger}
              promptsVersion={analysisPromptsVersion}
            />
          )}
        </div>
        <div className={activeTab === "Image Prompts" ? "" : "tab-hidden"}>
          {loading ? (
            <RightPanePlaceholder message="Loading post…" />
          ) : (
            <ImagePromptsTab postId={postId} content={content} />
          )}
        </div>
        <div className={activeTab === "Preview" ? "" : "tab-hidden"}>
          {loading ? (
            <RightPanePlaceholder message="Loading post…" />
          ) : (
            <PreviewTab workspaceId={workspaceId} content={content} postId={postId} />
          )}
        </div>
        <div className={activeTab === "Metadata" ? "" : "tab-hidden"}>
          {loading || !frontMatter ? (
            <RightPanePlaceholder message="Loading metadata…" />
          ) : (
            <MetadataTab
              ref={metadataRef}
              key={postId}
              workspaceId={workspaceId}
              postId={postId}
              frontMatter={frontMatter}
              target={target}
              content={content}
              extraFieldWatermark={extraFieldWatermark}
              onPostUpdated={onPostUpdated}
              isActive={activeTab === "Metadata"}
              readOnly={isPublished}
            />
          )}
        </div>
        <div className={activeTab === "Assets" ? "" : "tab-hidden"}>
          {loading ? (
            <RightPanePlaceholder message="Loading assets…" />
          ) : (
            <AssetsTab
              key={postId}
              workspaceId={workspaceId}
              postId={postId}
              onInsertAtCursor={onInsertAtCursor}
              maxUploadMb={maxUploadMb}
              readOnly={isPublished}
            />
          )}
        </div>
      </div>
    </div>
  );
});

function RightPanePlaceholder({ message }: { message: string }) {
  return <div className="right-pane-placeholder">{message}</div>;
}
