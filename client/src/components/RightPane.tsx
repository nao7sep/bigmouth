import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { AnalysisTab } from "./AnalysisTab";
import { ImagingTab } from "./ImagingTab";
import { AssetsTab } from "./AssetsTab";
import { PreviewTab } from "./PreviewTab";
import { MetadataTab, type MetadataTabHandle } from "./MetadataTab";
import type { PostFrontMatter, PostMutationResult, Target } from "../types";

export const RIGHT_TABS = ["Analysis", "Imaging", "Assets", "Preview", "Metadata"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

interface RightPaneProps {
  workspaceId: string;
  content: string;
  postId: string;
  frontMatter: PostFrontMatter | null;
  target: Target | null;
  extraFieldWatermark: string;
  onPostUpdated: (result: PostMutationResult) => void;
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
  const locked = frontMatter?.status === "published";

  // The Metadata tab is only meaningful for targets that require metadata.
  const showMetadata = target?.requiresMetadata ?? false;
  const visibleTabs: RightTab[] = showMetadata
    ? [...RIGHT_TABS]
    : RIGHT_TABS.filter((t) => t !== "Metadata");
  const effectiveTab = visibleTabs.includes(activeTab) ? activeTab : visibleTabs[0];

  useEffect(() => {
    if (effectiveTab !== activeTab) onTabChange(effectiveTab);
  }, [effectiveTab, activeTab, onTabChange]);

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
        {visibleTabs.map((tab) => (
          <button
            key={tab}
            className={`right-tab${effectiveTab === tab ? " active" : ""}`}
            onClick={() => onTabChange(tab)}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="right-content">
        <div className={effectiveTab === "Analysis" ? "" : "tab-hidden"}>
          {loading ? (
            <RightPanePlaceholder message="Loading post…" />
          ) : (
            <AnalysisTab
              postId={postId}
              content={content}
              analysisTrigger={analysisTrigger}
              promptsVersion={analysisPromptsVersion}
            />
          )}
        </div>
        <div className={effectiveTab === "Imaging" ? "" : "tab-hidden"}>
          {loading ? (
            <RightPanePlaceholder message="Loading post…" />
          ) : (
            <ImagingTab postId={postId} content={content} />
          )}
        </div>
        <div className={effectiveTab === "Preview" ? "" : "tab-hidden"}>
          {loading ? (
            <RightPanePlaceholder message="Loading post…" />
          ) : (
            <PreviewTab workspaceId={workspaceId} content={content} postId={postId} />
          )}
        </div>
        {showMetadata && (
          <div className={effectiveTab === "Metadata" ? "" : "tab-hidden"}>
            {loading || !frontMatter ? (
              <RightPanePlaceholder message="Loading metadata…" />
            ) : (
              <MetadataTab
                ref={metadataRef}
                key={postId}
                workspaceId={workspaceId}
                postId={postId}
                frontMatter={frontMatter}
                content={content}
                extraFieldWatermark={extraFieldWatermark}
                onPostUpdated={onPostUpdated}
                isActive={effectiveTab === "Metadata"}
                readOnly={locked}
              />
            )}
          </div>
        )}
        <div className={effectiveTab === "Assets" ? "" : "tab-hidden"}>
          {loading ? (
            <RightPanePlaceholder message="Loading assets…" />
          ) : (
            <AssetsTab
              key={postId}
              workspaceId={workspaceId}
              postId={postId}
              onInsertAtCursor={onInsertAtCursor}
              maxUploadMb={maxUploadMb}
              readOnly={locked}
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
