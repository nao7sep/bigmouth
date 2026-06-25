import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { AnalysisTab } from "./AnalysisTab";
import { ImagingTab } from "./ImagingTab";
import { AssetsTab } from "./AssetsTab";
import { PreviewTab } from "./PreviewTab";
import { MetadataTab, type MetadataTabHandle } from "./MetadataTab";
import { useTablist } from "../hooks/useTablist";
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
  const locked = frontMatter?.status === "published" || frontMatter?.status === "expired";

  // The Metadata tab is only meaningful for targets that require metadata.
  const showMetadata = target?.requiresMetadata ?? false;
  const visibleTabs: RightTab[] = showMetadata
    ? [...RIGHT_TABS]
    : RIGHT_TABS.filter((t) => t !== "Metadata");
  const effectiveTab = visibleTabs.includes(activeTab) ? activeTab : visibleTabs[0];

  useEffect(() => {
    if (effectiveTab !== activeTab) onTabChange(effectiveTab);
  }, [effectiveTab, activeTab, onTabChange]);

  const { tablistProps, getTabProps, getPanelProps } = useTablist<RightTab>({
    tabs: visibleTabs,
    selected: effectiveTab,
    onSelect: onTabChange,
    idBase: "right",
  });

  useImperativeHandle(
    ref,
    () => ({
      flushPendingChanges: async () => (await metadataRef.current?.flushPendingChanges()) ?? true,
    }),
    []
  );

  return (
    <div className="pane-right">
      <div className="right-tabs" aria-label="Tools" {...tablistProps}>
        {visibleTabs.map((tab) => {
          const { onClick, ...tabProps } = getTabProps(tab);
          return (
            <button
              key={tab}
              className={`right-tab${effectiveTab === tab ? " active" : ""}`}
              onClick={onClick}
              {...tabProps}
            >
              {tab}
            </button>
          );
        })}
      </div>
      <div className="right-content">
        <div
          {...getPanelProps("Analysis")}
          className={effectiveTab === "Analysis" ? "" : "tab-hidden"}
        >
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
        <div
          {...getPanelProps("Imaging")}
          className={effectiveTab === "Imaging" ? "" : "tab-hidden"}
        >
          {loading ? (
            <RightPanePlaceholder message="Loading post…" />
          ) : (
            <ImagingTab postId={postId} content={content} />
          )}
        </div>
        <div
          {...getPanelProps("Preview")}
          className={effectiveTab === "Preview" ? "" : "tab-hidden"}
        >
          {loading ? (
            <RightPanePlaceholder message="Loading post…" />
          ) : (
            <PreviewTab workspaceId={workspaceId} content={content} postId={postId} />
          )}
        </div>
        {showMetadata && (
          <div
            {...getPanelProps("Metadata")}
            className={effectiveTab === "Metadata" ? "" : "tab-hidden"}
          >
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
        <div
          {...getPanelProps("Assets")}
          className={effectiveTab === "Assets" ? "" : "tab-hidden"}
        >
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
