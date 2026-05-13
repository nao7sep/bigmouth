import { useEffect, useRef, useState } from "react";
import {
  generateImagePrompts,
  type ImagePromptEmotionalLens,
  type ImagePromptLiteralness,
  type ImagePromptOptions,
  type ImagePromptPeople,
  type ImagePromptRelation,
  type ImagePromptStyle,
} from "../api";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

const COUNT_OPTIONS = [3, 5, 10] as const;
const RELATION_OPTIONS: Array<{ value: ImagePromptRelation; label: string }> = [
  { value: "direct", label: "Direct" },
  { value: "domain", label: "Domain" },
  { value: "abstract", label: "Abstract" },
];
const EMOTIONAL_LENS_OPTIONS: Array<{ value: ImagePromptEmotionalLens; label: string }> = [
  { value: "bright", label: "Bright" },
  { value: "calm", label: "Calm" },
  { value: "neutral", label: "Neutral" },
  { value: "intense", label: "Intense" },
  { value: "hopeful", label: "Hopeful" },
];
const LITERALNESS_OPTIONS: Array<{ value: ImagePromptLiteralness; label: string }> = [
  { value: "literal", label: "Literal" },
  { value: "stylized", label: "Stylized" },
  { value: "symbolic", label: "Symbolic" },
];
const PEOPLE_OPTIONS: Array<{ value: ImagePromptPeople; label: string }> = [
  { value: "people", label: "People" },
  { value: "mixed", label: "Mixed" },
  { value: "no-people", label: "No people" },
];
const STYLE_OPTIONS: Array<{ value: ImagePromptStyle; label: string }> = [
  { value: "photo", label: "Photo" },
  { value: "illustration", label: "Illustration" },
  { value: "anime", label: "Anime" },
  { value: "cinematic", label: "Cinematic" },
  { value: "minimal", label: "Minimal" },
];

const DEFAULT_OPTIONS: ImagePromptOptions = {
  count: 5,
  relation: "domain",
  emotionalLens: "hopeful",
  literalness: "stylized",
  people: "mixed",
  style: "illustration",
};

interface ImagePromptsTabProps {
  postId: string;
  content: string;
}

export function ImagePromptsTab({ postId, content }: ImagePromptsTabProps) {
  const [options, setOptions] = useState<ImagePromptOptions>(DEFAULT_OPTIONS);
  const [items, setItems] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const { copiedKey, copy } = useCopyFeedback();

  useEffect(() => {
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setItems([]);
    setError(null);
    setLoading(false);
  }, [postId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const update = <K extends keyof ImagePromptOptions>(key: K, value: ImagePromptOptions[K]) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const run = async () => {
    if (loading || !content.trim()) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const myId = ++runIdRef.current;

    setLoading(true);
    setError(null);
    setItems([]);

    try {
      const nextItems = await generateImagePrompts(postId, content, options, controller.signal);
      if (runIdRef.current !== myId) return;
      setItems(nextItems);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (runIdRef.current !== myId) return;
      setError(err instanceof Error ? err.message : "Image prompt generation failed");
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
    <div className="image-prompts-tab">
      <div className="image-prompts-toolbar">
        <div className="image-prompts-note">English only. Results are temporary and not saved.</div>
        <button
          className="btn-analyze"
          onClick={run}
          disabled={loading || !content.trim()}
        >
          {loading ? "Generating…" : "Generate"}
        </button>
      </div>

      <div className="image-prompts-controls">
        <div className="image-prompts-field">
          <label>Count</label>
          <select
            className="ai-prompt-select"
            value={options.count}
            onChange={(e) => update("count", parseInt(e.target.value, 10) as ImagePromptOptions["count"])}
            disabled={loading}
          >
            {COUNT_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="image-prompts-field">
          <label>Relation</label>
          <select
            className="ai-prompt-select"
            value={options.relation}
            onChange={(e) => update("relation", e.target.value as ImagePromptRelation)}
            disabled={loading}
          >
            {RELATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="image-prompts-field">
          <label>Emotional lens</label>
          <select
            className="ai-prompt-select"
            value={options.emotionalLens}
            onChange={(e) => update("emotionalLens", e.target.value as ImagePromptEmotionalLens)}
            disabled={loading}
          >
            {EMOTIONAL_LENS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="image-prompts-field">
          <label>Literalness</label>
          <select
            className="ai-prompt-select"
            value={options.literalness}
            onChange={(e) => update("literalness", e.target.value as ImagePromptLiteralness)}
            disabled={loading}
          >
            {LITERALNESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="image-prompts-field">
          <label>People</label>
          <select
            className="ai-prompt-select"
            value={options.people}
            onChange={(e) => update("people", e.target.value as ImagePromptPeople)}
            disabled={loading}
          >
            {PEOPLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="image-prompts-field">
          <label>Style</label>
          <select
            className="ai-prompt-select"
            value={options.style}
            onChange={(e) => update("style", e.target.value as ImagePromptStyle)}
            disabled={loading}
          >
            {STYLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <div className="ai-error">{error}</div>}

      {!content.trim() && (
        <div className="ai-empty">Write some post content first.</div>
      )}

      {items.length > 0 && (
        <div className="image-prompts-results">
          <div className="image-prompts-results-header">
            <div className="image-prompts-note">{items.length} prompts</div>
            <button
              className="meta-field-copy"
              onClick={() => copy(items.join("\n\n"), "all")}
              title="Copy all prompts"
            >
              {copiedKey === "all" ? "✓ Copied" : "Copy All"}
            </button>
          </div>
          {items.map((item, index) => (
            <div key={`${index}-${item.slice(0, 24)}`} className="image-prompt-card">
              <div className="image-prompt-header">
                <div className="meta-field-label">Prompt {index + 1}</div>
                <button
                  className="meta-field-copy"
                  onClick={() => copy(item, `prompt-${index}`)}
                  title="Copy prompt"
                >
                  {copiedKey === `prompt-${index}` ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <div className="image-prompt-text">{item}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
