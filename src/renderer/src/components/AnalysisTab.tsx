import { useEffect, useRef, useState } from "react";
import { listAnalysisPrompts, runAnalysisStream } from "../api";
import type { AnalysisPrompt } from "@shared/types";
import { renderSafeMarkdown } from "../util/safeMarkdown";

interface AnalysisTabProps {
  postId: string;
  content: string;
  analysisTrigger: number;
  promptsVersion: number;
}

export function AnalysisTab({
  postId,
  content,
  analysisTrigger,
  promptsVersion,
}: AnalysisTabProps) {
  const [prompts, setPrompts] = useState<AnalysisPrompt[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState("");
  const [result, setResult] = useState<string | null>(null);
  // The model's reasoning, when the active AI config has thinking on. It arrives
  // before any answer text, so it is also what fills the wait.
  const [thinking, setThinking] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Load prompts on mount and after Settings updates them
  useEffect(() => {
    listAnalysisPrompts()
      .then((list) => {
        setPromptsError(null);
        setPrompts(list);
        setSelectedPrompt((current) => {
          if (list.length === 0) return "";
          return list.some((p) => p.name === current) ? current : list[0].name;
        });
      })
      .catch((err) => {
        setPromptsError(err instanceof Error ? err.message : "Failed to load analysis prompts.");
      });
  }, [promptsVersion]);

  // Reset state and cancel any in-flight analysis when post changes
  useEffect(() => {
    runIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setResult(null);
    setThinking(null);
    setError(null);
    setLoading(false);
  }, [postId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const run = async () => {
    if (!selectedPrompt || loading || !content.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const myId = ++runIdRef.current;
    setLoading(true);
    setError(null);
    setResult("");
    setThinking(null);
    try {
      await runAnalysisStream(postId, selectedPrompt, content, {
        signal: controller.signal,
        onChunk: (delta) => {
          if (runIdRef.current !== myId) return;
          setResult((prev) => (prev ?? "") + delta);
        },
        onThinking: (delta) => {
          if (runIdRef.current !== myId) return;
          setThinking((prev) => (prev ?? "") + delta);
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (runIdRef.current !== myId) return;
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      if (runIdRef.current === myId) setLoading(false);
    }
  };

  // Fire when analysisTrigger increments (Cmd+Enter).
  const prevTriggerRef = useRef(analysisTrigger);
  useEffect(() => {
    if (analysisTrigger > prevTriggerRef.current) {
      prevTriggerRef.current = analysisTrigger;
      run();
    }
  });

  if (prompts.length === 0 && !loading) {
    if (promptsError) {
      return <div className="panel-error">Couldn't load analysis prompts: {promptsError}</div>;
    }
    return (
      <div className="panel-empty">
        No prompts configured. Add prompts in{" "}
        <strong>Settings → Analysis</strong>.
      </div>
    );
  }

  const html = result ? renderSafeMarkdown(result) : null;

  return (
    <div className="analysis-tab">
      <div className="analysis-toolbar">
        <select
          className="prompt-select"
          value={selectedPrompt}
          onChange={(e) => setSelectedPrompt(e.target.value)}
          disabled={loading}
        >
          {prompts.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          className="action-button"
          onClick={run}
          disabled={loading || !selectedPrompt || !content.trim()}
        >
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </div>

      {error && <div className="panel-error">{error}</div>}

      {/* Open while it is the only thing to read, then collapsed once the answer
          arrives — the reasoning is what fills the wait, not the deliverable. */}
      {thinking && (
        <details className="analysis-thinking" open={!result}>
          <summary>Reasoning</summary>
          <div className="analysis-thinking-body">{thinking}</div>
        </details>
      )}

      {html && (
        <div
          className="analysis-result preview-content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
