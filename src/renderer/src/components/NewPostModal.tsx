import { useState } from "react";
import { PostPickerList } from "./PostPickerList";
import { usePostPicker } from "../hooks/usePostPicker";
import { useConfirm } from "./ConfirmHost";
import { ModalShell } from "./ModalShell";
import type { Target } from "@shared/types";
import { OperationalResult } from "./OperationalResult";
import { presentFailure } from "../util/presentFailure";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";

interface NewPostModalProps {
  targets: Target[];
  supportedLanguages: string[];
  pubBatchSize: number;
  onClose: () => void;
  onCreate: (target: string, language: string, sourceId?: string) => Promise<void> | void;
}

function resolveLanguage(
  lang: string | undefined,
  supportedLanguages: string[]
): string {
  if (lang && supportedLanguages.includes(lang)) return lang;
  if (supportedLanguages.includes("en")) return "en";
  return supportedLanguages[0] ?? "";
}

export function NewPostModal({
  targets,
  supportedLanguages,
  pubBatchSize,
  onClose,
  onCreate,
}: NewPostModalProps) {
  const { t, text } = useI18n();
  const [selectedTarget, setSelectedTarget] = useState("");
  const [selectedLanguage, setSelectedLanguage] = useState(() =>
    resolveLanguage(undefined, supportedLanguages)
  );
  const [sourceId, setSourceId] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [createError, setCreateError] = useState<Message | null>(null);
  const [creating, setCreating] = useState(false);
  const confirm = useConfirm();

  const initialLanguage = resolveLanguage(undefined, supportedLanguages);
  const isDirty =
    selectedTarget !== "" ||
    selectedLanguage !== initialLanguage ||
    sourceId !== "";

  const handleRequestClose = async () => {
    if (!isDirty) {
      onClose();
      return;
    }
    const ok = await confirm({
      title: t("newPost.discardTitle"),
      message: t("newPost.discardMessage"),
      confirmLabel: t("common.discard"),
      cancelLabel: t("common.keepEditing"),
      danger: true,
    });
    if (ok) onClose();
  };

  const picker = usePostPicker(pubBatchSize);
  const hasTargets = targets.length > 0;
  const hasLanguages = supportedLanguages.length > 0;

  const handleTargetChange = (name: string) => {
    setCreateError(null);
    setSelectedTarget(name);
    const target = targets.find((candidate) => candidate.name === name);
    setSelectedLanguage(resolveLanguage(target?.defaultLanguage, supportedLanguages));
  };

  const handleCreate = async () => {
    if (!hasTargets) {
      setCreateError(message("newPost.noTargets"));
      return;
    }
    if (!hasLanguages) {
      setCreateError(message("newPost.noLanguages"));
      return;
    }
    if (!selectedTarget) {
      setCreateError(message("newPost.selectTarget"));
      return;
    }
    if (!selectedLanguage || !supportedLanguages.includes(selectedLanguage)) {
      setCreateError(message("newPost.selectLanguage"));
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(selectedTarget, selectedLanguage, sourceId || undefined);
    } catch (err) {
      setCreateError(presentFailure(
        message("newPost.createFailed"),
        "renderer: post creation failed",
        err,
      ));
    } finally {
      setCreating(false);
    }
  };

  return (
    <ModalShell title={t("left.newPost")} onClose={() => void handleRequestClose()} width={440}>
      <div className="modal-body">
        <div className="form-field">
          <label className="form-label">{t("newPost.target")}</label>
          {hasTargets ? (
            <select
              className="form-select"
              value={selectedTarget}
              onChange={(e) => handleTargetChange(e.target.value)}
              autoFocus
            >
              <option value="" disabled>{t("newPost.selectPlaceholder")}</option>
              {targets.map((target) => (
                <option key={target.name} value={target.name}>
                  {t("newPost.targetOption", { name: target.name, language: target.defaultLanguage })}
                </option>
              ))}
            </select>
          ) : (
            <OperationalResult severity="warning" className="modal-result">
              {t("newPost.noTargets")}
            </OperationalResult>
          )}
        </div>

        <div className="form-field">
          <label className="form-label">{t("newPost.language")}</label>
          {hasLanguages ? (
            <select
              className="form-select"
              value={selectedLanguage}
              onChange={(e) => {
                setCreateError(null);
                setSelectedLanguage(e.target.value);
              }}
            >
              {supportedLanguages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          ) : (
            <OperationalResult severity="warning" className="modal-result">
              {t("newPost.noLanguagesGeneral")}
            </OperationalResult>
          )}
        </div>

        <div className="form-field">
          <label className="form-label">{t("newPost.source")}</label>
          {sourceId ? (
            <div className="source-selected">
              <span className="source-selected-title">{sourceTitle}</span>
              <button
                className="btn-toolbar"
                onClick={() => { setSourceId(""); setSourceTitle(""); }}
              >
                {t("newPost.unlink")}
              </button>
            </div>
          ) : (
            <PostPickerList
              {...picker}
              onSelect={(id, title) => {
                setCreateError(null);
                setSourceId(id);
                setSourceTitle(title);
                picker.setQuery("");
              }}
            />
          )}
        </div>
        {createError && (
          <OperationalResult severity="error" className="modal-result">
            {text(createError)}
          </OperationalResult>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn-action" onClick={() => void handleRequestClose()}>
          {t("common.cancel")}
        </button>
        <button
          className="btn-primary"
          onClick={handleCreate}
          disabled={!hasTargets || !hasLanguages || !selectedTarget || !selectedLanguage || creating}
        >
          {creating ? t("newPost.creating") : t("newPost.create")}
        </button>
      </div>
    </ModalShell>
  );
}
