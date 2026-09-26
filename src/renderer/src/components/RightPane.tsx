import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { AnalysisTab } from "./AnalysisTab";
import { ImagingTab } from "./ImagingTab";
import { AssetsTab } from "./AssetsTab";
import { PreviewTab } from "./PreviewTab";
import { MetadataTab, type MetadataTabHandle } from "./MetadataTab";
import { useTablist } from "../hooks/useTablist";
import type { ContentFont, EditablePostMetadata, PostFrontMatter, Target } from "@shared/types";
import { isEditLocked } from "@shared/postStatus";
import { useI18n } from "../i18n/I18nContext";
import type { MessageKey } from "@shared/i18n/catalogues";

export const RIGHT_TABS = ["Analysis", "Imaging", "Assets", "Preview", "Metadata"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

// The tab ids are English words; what the tab says comes from the catalogue.
const TAB_LABELS: Record<RightTab, MessageKey> = {
  Analysis: "tabs.analysis",
  Imaging: "tabs.imaging",
  Assets: "tabs.assets",
  Preview: "tabs.preview",
  Metadata: "tabs.metadata",
};

interface RightPaneProps {
  workspaceId: string;
  content: string;
  postId: string;
  frontMatter: PostFrontMatter | null;
  target: Target | null;
  extraFieldWatermark: string;
  onMetadataEdited: (postId: string, edits: EditablePostMetadata) => void;
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
  analysisTrigger: number;
  analysisPromptsVersion: number;
  onInsertAtCursor: (text: string) => void;
  maxUploadMb: number;
  contentFont: ContentFont;
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
    onMetadataEdited,
    activeTab,
    onTabChange,
    analysisTrigger,
    analysisPromptsVersion,
    onInsertAtCursor,
    maxUploadMb,
    contentFont,
    loading = false,
  },
  ref
) {
  const { t } = useI18n();
  const metadataRef = useRef<MetadataTabHandle>(null);
  const locked = frontMatter ? isEditLocked(frontMatter.status) : false;

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
      <div className="right-tabs" aria-label={t("right.tools")} {...tablistProps}>
        {visibleTabs.map((tab) => {
          const { onClick, ...tabProps } = getTabProps(tab);
          return (
            <button
              key={tab}
              className={`right-tab${effectiveTab === tab ? " active" : ""}`}
              onClick={onClick}
              {...tabProps}
            >
              {t(TAB_LABELS[tab])}
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
            <RightPanePlaceholder message={t("center.loadingPost")} />
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
            <RightPanePlaceholder message={t("center.loadingPost")} />
          ) : (
            <ImagingTab postId={postId} content={content} />
          )}
        </div>
        <div
          {...getPanelProps("Preview")}
          className={effectiveTab === "Preview" ? "" : "tab-hidden"}
        >
          {loading ? (
            <RightPanePlaceholder message={t("center.loadingPost")} />
          ) : (
            <PreviewTab
              workspaceId={workspaceId}
              content={content}
              postId={postId}
              contentFont={contentFont}
            />
          )}
        </div>
        {showMetadata && (
          <div
            {...getPanelProps("Metadata")}
            className={effectiveTab === "Metadata" ? "" : "tab-hidden"}
          >
            {loading || !frontMatter ? (
              <RightPanePlaceholder message={t("right.loadingMetadata")} />
            ) : (
              <MetadataTab
                ref={metadataRef}
                key={postId}
                workspaceId={workspaceId}
                postId={postId}
                frontMatter={frontMatter}
                content={content}
                extraFieldWatermark={extraFieldWatermark}
                onMetadataEdited={onMetadataEdited}
                isActive={effectiveTab === "Metadata"}
                readOnly={locked}
              />
            )}
          </div>
        )}
        {loading ? (
          <div
            {...getPanelProps("Assets")}
            className={effectiveTab === "Assets" ? "" : "tab-hidden"}
          >
            <RightPanePlaceholder message={t("right.loadingAssets")} />
          </div>
        ) : (
          <AssetsTab
            {...getPanelProps("Assets")}
            className={effectiveTab === "Assets" ? "" : "tab-hidden"}
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
  );
});

function RightPanePlaceholder({ message }: { message: string }) {
  return <div className="right-pane-placeholder">{message}</div>;
}
