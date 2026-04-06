import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { fetchAnalysisPrompts, runAnalysis } from "../api";
import type { AnalysisPrompt } from "../types";

interface AiAnalysisTabProps {
  postId: string;
  analysisTrigger: number; // incremented by Cmd+Enter to auto-run
}

export function AiAnalysisTab({ postId, analysisTrigger }: AiAnalysisTabProps) {
  const [prompts, setPrompts] = useState<AnalysisPrompt[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load prompts on mount
  useEffect(() => {
    fetchAnalysisPrompts()
      .then((list) => {
        setPrompts(list);
        if (list.length > 0) setSelectedPrompt(list[0].name);
      })
      .catch(() => {});
  }, []);

  const run = async () => {
    if (!selectedPrompt || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const text = await runAnalysis(postId, selectedPrompt);
      setResult(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  };

  // Fire when analysisTrigger increments (Cmd+Enter)
  const prevTriggerRef = useRef(analysisTrigger);
  useEffect(() => {
    if (analysisTrigger > prevTriggerRef.current) {
      prevTriggerRef.current = analysisTrigger;
      run();
    }
  });

  if (prompts.length === 0 && !loading) {
    return (
      <div className="ai-empty">
        No prompts configured. Add prompts in{" "}
        <strong>Settings → Prompts</strong>.
      </div>
    );
  }

  const html = result ? (marked(result) as string) : null;

  return (
    <div className="ai-analysis-tab">
      <div className="ai-toolbar">
        <select
          className="ai-prompt-select"
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
          className="btn-analyze"
          onClick={run}
          disabled={loading || !selectedPrompt}
        >
          {loading ? "Analyzing…" : "Analyze"}
        </button>
      </div>

      {error && <div className="ai-error">{error}</div>}

      {loading && (
        <div className="ai-loading">Running analysis…</div>
      )}

      {html && !loading && (
        <div
          className="ai-result preview-content"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
