import { useEffect, useRef, useState } from "react";
import { PostPickerList } from "./PostPickerList";
import { usePostPicker } from "../hooks/usePostPicker";
import { useConfirm } from "./ConfirmHost";
import { ModalShell } from "./ModalShell";
import type { Target } from "@shared/types";
import { OperationalResult } from "./OperationalResult";
import { presentFailure } from "../util/presentFailure";
import { useI18n } from "../i18n/I18nContext";
import { message, type Message } from "@shared/i18n/translate";
import { StoragePendingNotice, useStoragePending, useStorageResultReporter } from "../StoragePending";

interface NewPostModalProps {
  targets: Target[];
  supportedLanguages: string[];
  pubBatchSize: number;
  onClose: () => void;
  onCreate: (target: string, language: string, sourceId?: string, mayAdopt?: () => boolean) => Promise<void> | void;
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
  const storagePending = useStoragePending();
  const reportStorageResult = useStorageResultReporter();
  const current = useRef(true);
  const creatingRef = useRef(false);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const close = () => { if (!current.current) return; current.current = false; onClose(); };
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
    if (!current.current) return;
    if (creatingRef.current) { if (storagePending) close(); return; }
    if (!isDirty) {
      close();
      return;
    }
    const ok = await confirm({
      title: t("common.discardTitle"),
      message: t("common.discardMessage"),
      confirmLabel: t("common.discard"),
      cancelLabel: t("common.keepEditing"),
      danger: true,
    });
    if (ok && current.current) close();
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
    if (creatingRef.current || storagePending || !current.current) return;
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

    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(selectedTarget, selectedLanguage, sourceId || undefined, () => current.current);
    } catch (err) {
      const failure = presentFailure(message(current.current ? "newPost.createFailed" : "app.storageChangeFailed"), "renderer: post creation failed", err);
      if (current.current) setCreateError(failure);
      else reportStorageResult(failure);
    } finally {
      creatingRef.current = false;
      if (current.current) setCreating(false);
    }
  };

  return (
    <ModalShell title={t("left.newPost")} onClose={() => void handleRequestClose()} width={440} closeDisabled={creating && !storagePending}>
      <div className="modal-body">
        <StoragePendingNotice />
        <fieldset disabled={creating} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
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
        </fieldset>
        {createError && (
          <OperationalResult severity="error" className="modal-result">
            {text(createError)}
          </OperationalResult>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn-action" onClick={() => void handleRequestClose()} disabled={creating && !storagePending}>
          {creating && storagePending ? t("common.close") : t("common.cancel")}
        </button>
        <button
          className="btn-primary"
          onClick={handleCreate}
          disabled={!hasTargets || !hasLanguages || !selectedTarget || !selectedLanguage || creating || storagePending}
        >
          {creating ? t("newPost.creating") : t("newPost.create")}
        </button>
      </div>
    </ModalShell>
  );
}
