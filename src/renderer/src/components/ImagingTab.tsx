import { useEffect, useRef, useState } from "react";
import {
  generateImaging,
  type ImagingLiteralness,
  type ImagingMood,
  type ImagingOptions,
  type ImagingPeople,
  type ImagingRelation,
  type ImagingStyle,
} from "../api";
import { presentFailure } from "../util/presentFailure";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { CheckIcon } from "./Icon";
import { OperationalResult } from "./OperationalResult";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import type { MessageKey } from "@shared/i18n/catalogues";

const COUNT_OPTIONS = [3, 5, 10] as const;
const RELATION_OPTIONS: Array<{ value: ImagingRelation; label: MessageKey }> = [
  { value: "direct", label: "imaging.relation.direct" },
  { value: "domain", label: "imaging.relation.domain" },
  { value: "abstract", label: "imaging.relation.abstract" },
];
const MOOD_OPTIONS: Array<{ value: ImagingMood; label: MessageKey }> = [
  { value: "bright", label: "imaging.mood.bright" },
  { value: "calm", label: "imaging.mood.calm" },
  { value: "neutral", label: "imaging.mood.neutral" },
  { value: "intense", label: "imaging.mood.intense" },
  { value: "hopeful", label: "imaging.mood.hopeful" },
];
const LITERALNESS_OPTIONS: Array<{ value: ImagingLiteralness; label: MessageKey }> = [
  { value: "literal", label: "imaging.literalness.literal" },
  { value: "stylized", label: "imaging.literalness.stylized" },
  { value: "symbolic", label: "imaging.literalness.symbolic" },
];
const PEOPLE_OPTIONS: Array<{ value: ImagingPeople; label: MessageKey }> = [
  { value: "people", label: "imaging.people.people" },
  { value: "mixed", label: "imaging.people.mixed" },
  { value: "no-people", label: "imaging.people.noPeople" },
];
const STYLE_OPTIONS: Array<{ value: ImagingStyle; label: MessageKey }> = [
  { value: "photo", label: "imaging.style.photo" },
  { value: "illustration", label: "imaging.style.illustration" },
  { value: "anime", label: "imaging.style.anime" },
  { value: "cinematic", label: "imaging.style.cinematic" },
  { value: "minimal", label: "imaging.style.minimal" },
];

const DEFAULT_OPTIONS: ImagingOptions = {
  count: 5,
  relation: "domain",
  emotionalLens: "hopeful",
  literalness: "stylized",
  people: "mixed",
  style: "illustration",
};

interface ImagingTabProps {
  postId: string;
  content: string;
}

export function ImagingTab({ postId, content }: ImagingTabProps) {
  const { t, text, number } = useI18n();
  const [options, setOptions] = useState<ImagingOptions>(DEFAULT_OPTIONS);
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const {
    copiedKey,
    copy,
    copyErrors,
    dismissCopyError,
    clearCopyErrors,
  } = useCopyFeedback();

  useEffect(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setItems([]);
    setError(null);
    setLoading(false);
    clearCopyErrors();
  }, [postId, clearCopyErrors]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const update = <K extends keyof ImagingOptions>(key: K, value: ImagingOptions[K]) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const run = async () => {
    if (loading || !content.trim()) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const myId = ++runIdRef.current;

    // The earlier prompts stay until a new set arrives: a failed or stopped run
    // leaves them as they were.
    setLoading(true);
    setError(null);
    clearCopyErrors();

    try {
      const nextItems = await generateImaging(postId, content, options, controller.signal);
      if (runIdRef.current !== myId) return;
      setItems(nextItems);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (runIdRef.current !== myId) return;
      setError(presentFailure(
        message("imaging.failed"),
        "renderer: imaging generation failed",
        err,
        { postId },
      ));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      if (runIdRef.current === myId) {
        setLoading(false);
      }
    }
  };

  return (
    <div className="imaging-tab">
      <div className="imaging-toolbar">
        <div className="imaging-note">
          {t("imaging.note")}
        </div>
        {/* While it runs, Generate becomes Stop, which cancels the paid call. */}
        <button
          className="action-button"
          onClick={loading ? stop : run}
          disabled={!loading && !content.trim()}
        >
          {loading ? t("common.stop") : t("imaging.generate")}
        </button>
      </div>

      <div className="imaging-controls">
        <div className="imaging-field">
          <label>{t("imaging.count")}</label>
          <select
            className="prompt-select"
            value={options.count}
            onChange={(e) => update("count", parseInt(e.target.value, 10) as ImagingOptions["count"])}
            disabled={loading}
          >
            {COUNT_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {number(value)}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>{t("imaging.relation")}</label>
          <select
            className="prompt-select"
            value={options.relation}
            onChange={(e) => update("relation", e.target.value as ImagingRelation)}
            disabled={loading}
          >
            {RELATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>{t("imaging.mood")}</label>
          <select
            className="prompt-select"
            value={options.emotionalLens}
            onChange={(e) => update("emotionalLens", e.target.value as ImagingMood)}
            disabled={loading}
          >
            {MOOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>{t("imaging.literalness")}</label>
          <select
            className="prompt-select"
            value={options.literalness}
            onChange={(e) => update("literalness", e.target.value as ImagingLiteralness)}
            disabled={loading}
          >
            {LITERALNESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>{t("imaging.people")}</label>
          <select
            className="prompt-select"
            value={options.people}
            onChange={(e) => update("people", e.target.value as ImagingPeople)}
            disabled={loading}
          >
            {PEOPLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>{t("imaging.style")}</label>
          <select
            className="prompt-select"
            value={options.style}
            onChange={(e) => update("style", e.target.value as ImagingStyle)}
            disabled={loading}
          >
            {STYLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <OperationalResult severity="error" className="panel-error">
          {text(error)}
        </OperationalResult>
      )}

      {!content.trim() && (
        <div className="panel-empty">{t("imaging.noContent")}</div>
      )}

      {items.length > 0 && (
        <div className="imaging-results" role="region" aria-label={t("imaging.results")} tabIndex={0}>
          <div className="imaging-results-header">
            <div className="imaging-note">{t("imaging.promptCount", { count: items.length })}</div>
            <button
              className="meta-field-copy"
              onClick={() => copy(items.join("\n\n"), "all")}
              title={t("imaging.copyAllTitle")}
            >
              {copiedKey === "all" ? (
                <>
                  <CheckIcon /> {t("common.copied")}
                </>
              ) : (
                t("imaging.copyAll")
              )}
            </button>
          </div>
          {copyErrors.all && (
            <OperationalResult
              severity="error"
              className="metadata-error imaging-copy-error"
              dismissClassName="metadata-error-dismiss"
              onDismiss={() => dismissCopyError("all")}
            >
              {text(copyErrors.all)}
            </OperationalResult>
          )}
          {items.map((item, index) => (
            <div key={`${index}-${item.slice(0, 24)}`} className="image-prompt-card">
              <div className="image-prompt-header">
                <div className="meta-field-label">{t("imaging.promptNumber", { number: index + 1 })}</div>
                <button
                  className="meta-field-copy"
                  onClick={() => copy(item, `prompt-${index}`)}
                  title={t("imaging.copyPromptTitle")}
                >
                  {copiedKey === `prompt-${index}` ? (
                    <>
                      <CheckIcon /> {t("common.copied")}
                    </>
                  ) : (
                    t("common.copy")
                  )}
                </button>
              </div>
              {copyErrors[`prompt-${index}`] && (
                <OperationalResult
                  severity="error"
                  className="metadata-error imaging-copy-error"
                  dismissClassName="metadata-error-dismiss"
                  onDismiss={() => dismissCopyError(`prompt-${index}`)}
                >
                  {text(copyErrors[`prompt-${index}`]!)}
                </OperationalResult>
              )}
              <div className="image-prompt-text">{item}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
