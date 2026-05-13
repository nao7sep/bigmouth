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
import { useCopyFeedback } from "../hooks/useCopyFeedback";

const COUNT_OPTIONS = [3, 5, 10] as const;
const RELATION_OPTIONS: Array<{ value: ImagingRelation; label: string }> = [
  { value: "direct", label: "Direct" },
  { value: "domain", label: "Domain" },
  { value: "abstract", label: "Abstract" },
];
const MOOD_OPTIONS: Array<{ value: ImagingMood; label: string }> = [
  { value: "bright", label: "Bright" },
  { value: "calm", label: "Calm" },
  { value: "neutral", label: "Neutral" },
  { value: "intense", label: "Intense" },
  { value: "hopeful", label: "Hopeful" },
];
const LITERALNESS_OPTIONS: Array<{ value: ImagingLiteralness; label: string }> = [
  { value: "literal", label: "Literal" },
  { value: "stylized", label: "Stylized" },
  { value: "symbolic", label: "Symbolic" },
];
const PEOPLE_OPTIONS: Array<{ value: ImagingPeople; label: string }> = [
  { value: "people", label: "People" },
  { value: "mixed", label: "Mixed" },
  { value: "no-people", label: "No people" },
];
const STYLE_OPTIONS: Array<{ value: ImagingStyle; label: string }> = [
  { value: "photo", label: "Photo" },
  { value: "illustration", label: "Illustration" },
  { value: "anime", label: "Anime" },
  { value: "cinematic", label: "Cinematic" },
  { value: "minimal", label: "Minimal" },
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
  const [options, setOptions] = useState<ImagingOptions>(DEFAULT_OPTIONS);
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

  const update = <K extends keyof ImagingOptions>(key: K, value: ImagingOptions[K]) => {
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
      const nextItems = await generateImaging(postId, content, options, controller.signal);
      if (runIdRef.current !== myId) return;
      setItems(nextItems);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (runIdRef.current !== myId) return;
      setError(err instanceof Error ? err.message : "Imaging failed");
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
          English prompts only. The visual setting should still follow the draft&apos;s own cues. Results are temporary and not saved.
        </div>
        <button
          className="action-button"
          onClick={run}
          disabled={loading || !content.trim()}
        >
          {loading ? "Generating…" : "Generate"}
        </button>
      </div>

      <div className="imaging-controls">
        <div className="imaging-field">
          <label>Count</label>
          <select
            className="prompt-select"
            value={options.count}
            onChange={(e) => update("count", parseInt(e.target.value, 10) as ImagingOptions["count"])}
            disabled={loading}
          >
            {COUNT_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>Relation</label>
          <select
            className="prompt-select"
            value={options.relation}
            onChange={(e) => update("relation", e.target.value as ImagingRelation)}
            disabled={loading}
          >
            {RELATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>Mood</label>
          <select
            className="prompt-select"
            value={options.emotionalLens}
            onChange={(e) => update("emotionalLens", e.target.value as ImagingMood)}
            disabled={loading}
          >
            {MOOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>Literalness</label>
          <select
            className="prompt-select"
            value={options.literalness}
            onChange={(e) => update("literalness", e.target.value as ImagingLiteralness)}
            disabled={loading}
          >
            {LITERALNESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>People</label>
          <select
            className="prompt-select"
            value={options.people}
            onChange={(e) => update("people", e.target.value as ImagingPeople)}
            disabled={loading}
          >
            {PEOPLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="imaging-field">
          <label>Style</label>
          <select
            className="prompt-select"
            value={options.style}
            onChange={(e) => update("style", e.target.value as ImagingStyle)}
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

      {error && <div className="panel-error">{error}</div>}

      {!content.trim() && (
        <div className="panel-empty">Write some post content first.</div>
      )}

      {items.length > 0 && (
        <div className="imaging-results">
          <div className="imaging-results-header">
            <div className="imaging-note">{items.length} prompts</div>
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
