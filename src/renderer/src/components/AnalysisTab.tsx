import { useEffect, useRef, useState } from "react";
import { listAnalysisPrompts, runAnalysisStream } from "../api";
import { presentFailure } from "../util/presentFailure";
import type { AnalysisPrompt } from "@shared/types";
import { renderSafeMarkdown } from "../util/safeMarkdown";
import { OperationalResult } from "./OperationalResult";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";

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
  const { t, text, rich } = useI18n();
  const [prompts, setPrompts] = useState<AnalysisPrompt[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState("");
  const [result, setResult] = useState<string | null>(null);
  // The model's reasoning, when the analysis role's thinking is adaptive. It arrives
  // before any answer text, so it is also what fills the wait.
  const [thinking, setThinking] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(true);
  // A version change and keyboard trigger can share an effect pass, before
  // the loading state renders; the run guard must already see the pending read.
  const promptsLoadingRef = useRef(true);
  const [promptsError, setPromptsError] = useState<Message | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load prompts on mount and after Settings updates them
  useEffect(() => {
    let active = true;
    promptsLoadingRef.current = true;
    setPromptsLoading(true);
    setPromptsError(null);
    listAnalysisPrompts()
      .then((list) => {
        if (!active) return;
        setPrompts(list);
        setSelectedPrompt((current) => {
          if (list.length === 0) return "";
          return list.some((p) => p.name === current) ? current : list[0].name;
        });
      })
      .catch((err) => {
        if (!active) return;
        setPromptsError(presentFailure(
          message("analysis.promptsFailed"),
          "renderer: analysis prompts load failed",
          err,
        ));
      })
      .finally(() => {
        if (!active) return;
        promptsLoadingRef.current = false;
        setPromptsLoading(false);
      });
    return () => { active = false; };
  }, [promptsVersion]);

  // Reset state and cancel any in-flight analysis when post changes
  useEffect(() => {
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

  const stop = () => {
    abortRef.current?.abort();
  };

  const run = async () => {
    if (!selectedPrompt || loading || promptsLoadingRef.current || promptsError || !content.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setResult("");
    setThinking(null);
    try {
      await runAnalysisStream(postId, selectedPrompt, content, {
        signal: controller.signal,
        // A newer run, another post or leaving aborts this one's signal.
        onChunk: (delta) => {
          if (controller.signal.aborted) return;
          setResult((prev) => (prev ?? "") + delta);
        },
        onThinking: (delta) => {
          if (controller.signal.aborted) return;
          setThinking((prev) => (prev ?? "") + delta);
        },
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(presentFailure(
        message("analysis.runFailed"),
        "renderer: analysis run failed",
        err,
        { postId, prompt: selectedPrompt },
      ));
    } finally {
      // Still this run's, as after Stop: a newer run or another post owns the state otherwise.
      if (abortRef.current === controller) {
        abortRef.current = null;
        setLoading(false);
      }
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
    if (promptsLoading) {
      return <div className="panel-empty" role="status">{t("common.loading")}</div>;
    }
    if (promptsError) {
      return (
        <OperationalResult severity="error" className="panel-error">
          {text(promptsError)}
        </OperationalResult>
      );
    }
    return (
      <div className="panel-empty">
        {rich("analysis.noPrompts", {
          location: <strong>{t("analysis.promptsLocation")}</strong>,
        })}
      </div>
    );
  }

  const html = result ? renderSafeMarkdown(result) : null;

  return (
    <div className="analysis-tab">
      <div className="analysis-toolbar">
        <select
          className="prompt-select"
          aria-label={t("analysis.prompt")}
          value={selectedPrompt}
          onChange={(e) => setSelectedPrompt(e.target.value)}
          disabled={loading || promptsLoading || !!promptsError}
        >
          {prompts.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        {/* While it runs, Analyze becomes Stop, which cancels the paid stream. */}
        <button
          className="action-button"
          onClick={loading ? stop : run}
          disabled={!loading && (promptsLoading || !!promptsError || !selectedPrompt || !content.trim())}
        >
          {loading ? t("common.stop") : t("analysis.analyze")}
        </button>
      </div>

      {promptsLoading && <div className="panel-empty" role="status">{t("common.loading")}</div>}
      {promptsError && (
        <OperationalResult severity="error" className="panel-error">
          {text(promptsError)}
        </OperationalResult>
      )}

      {error && (
        <OperationalResult severity="error" className="panel-error">
          {text(error)}
        </OperationalResult>
      )}

      {/* Open while it is the only thing to read, then collapsed once the answer
          arrives — the reasoning is what fills the wait, not the deliverable. */}
      {thinking && (
        <details className="analysis-thinking" open={!result}>
          <summary>{t("analysis.reasoning")}</summary>
          <div className="analysis-thinking-body">{thinking}</div>
        </details>
      )}

      {html && (
        <div
          className="analysis-result preview-content"
          role="region"
          aria-label={t("analysis.result")}
          tabIndex={0}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}
