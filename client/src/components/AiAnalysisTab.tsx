import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import { fetchAnalysisPrompts, runAnalysis } from "../api";
import type { AnalysisPrompt } from "../types";

interface AiAnalysisTabProps {
  postId: string;
  content: string;
  analysisTrigger: number;
}

export function AiAnalysisTab({ postId, content, analysisTrigger }: AiAnalysisTabProps) {
  const [prompts, setPrompts] = useState<AnalysisPrompt[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef(0);

  // Load prompts on mount
  useEffect(() => {
    fetchAnalysisPrompts()
      .then((list) => {
        setPrompts(list);
        if (list.length > 0) setSelectedPrompt(list[0].name);
      })
      .catch(() => {});
  }, []);

  // Reset state and cancel any in-flight analysis when post changes
  useEffect(() => {
    runIdRef.current++;
    setResult(null);
    setError(null);
    setLoading(false);
  }, [postId]);

  const run = async () => {
    if (!selectedPrompt || loading || !content.trim()) return;
    const myId = ++runIdRef.current;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const text = await runAnalysis(postId, selectedPrompt, content);
      if (runIdRef.current !== myId) return; // post switched while in-flight
      setResult(text);
    } catch (err) {
      if (runIdRef.current !== myId) return;
      setError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      if (runIdRef.current === myId) setLoading(false);
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
        <strong>Settings → Analysis</strong>.
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
          disabled={loading || !selectedPrompt || !content.trim()}
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
