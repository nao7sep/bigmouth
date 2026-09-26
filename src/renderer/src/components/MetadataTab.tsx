import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { EditablePostMetadata, PostFrontMatter } from "@shared/types";
import {
  queuePostMetadata,
  reportMetadataRefusal,
  generateMetadataField,
  generateMetadataFields,
} from "../api";
import { presentFailure } from "../util/presentFailure";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { extractFields, parseFieldValue, untouchedGeneratedFields } from "../util/metadataFields";
import { CheckIcon } from "./Icon";
import { OperationalResult } from "./OperationalResult";

interface MetadataTabProps {
  workspaceId: string;
  postId: string;
  frontMatter: PostFrontMatter;
  content: string;
  extraFieldWatermark: string;
  /** Edits the main process has buffered, for views that show them (the export's slug). */
  onMetadataEdited: (postId: string, edits: EditablePostMetadata) => void;
  isActive?: boolean;
  readOnly?: boolean;
}

export interface MetadataTabHandle {
  /**
   * Readies the tab for the post to be left: cancels any generation, waits for
   * the edits already sent, and returns false (showing why) while a field holds
   * a value the store refused, such as a slug another post uses.
   */
  flushPendingChanges: () => Promise<boolean>;
}

export const MetadataTab = forwardRef<MetadataTabHandle, MetadataTabProps>(
  function MetadataTab(
    {
      workspaceId,
      postId,
      frontMatter,
      content,
      extraFieldWatermark,
      onMetadataEdited,
      isActive = false,
      readOnly = false,
    },
    ref
  ) {
    const lang = frontMatter.language;
    const isNonEnglish = lang !== "en";
    const noContent = !content.trim();

    // `fields` is the single source of truth for the editable values while this
    // tab is mounted. The component is keyed by postId (see RightPane), so it
    // remounts for each post and seeds from front matter exactly once.
    //
    // Every edit streams to the main-process post store as it happens, exactly
    // like the editor's content: the store owns the debounce, the disk write and
    // the flush at quit, so closing the window or quitting the moment after a
    // keystroke cannot lose it. `fieldsRef` mirrors `fields` for async readers
    // and is assigned at each mutation site, eagerly.
    const [fields, setFields] = useState(() => extractFields(frontMatter));
    const fieldsRef = useRef(fields);
    const [generating, setGenerating] = useState<Record<string, boolean>>({});
    const [generatingAll, setGeneratingAll] = useState(false);
    // `field` marks a refusal of that field's value, so fixing the field clears it.
    const [genError, setGenError] = useState<{ message: string; field?: string } | null>(null);
    const generationLockRef = useRef(false);
    // The in-flight generation's cancel. Navigation never waits on a paid call:
    // leaving the post, changing status or switching workspace aborts it, and
    // so does the Stop button that replaces Generate while it runs.
    const generationAbortRef = useRef<AbortController | null>(null);
    // The latest queue round-trip per field, and the value of a field the store
    // refused with the reason. Replies arrive in the order the edits were sent,
    // so the last reply for a field is about its newest value.
    const queuedRef = useRef<Record<string, Promise<void>>>({});
    const refusedRef = useRef<Record<string, { raw: string; message: string }>>({});
    // Whether main was last told this tab shows a refused value. A refused value
    // was never buffered, so it exists only on screen: main asks before quitting
    // or closing the window while any tab reports one.
    const reportedRefusalRef = useRef(false);
    const syncRefusalReport = useCallback(() => {
      const refused = Object.keys(refusedRef.current).length > 0;
      if (refused === reportedRefusalRef.current) return;
      reportedRefusalRef.current = refused;
      reportMetadataRefusal(postId, refused);
    }, [postId]);
    const {
      copiedKey,
      copy: copyToClipboard,
      copyErrors,
      dismissCopyError,
    } = useCopyFeedback();
    const onMetadataEditedRef = useRef(onMetadataEdited);

    useEffect(() => {
      onMetadataEditedRef.current = onMetadataEdited;
    }, [onMetadataEdited]);

    const showGenError = useCallback((message: string) => {
      setGenError({ message });
    }, []);

    const clearGenError = useCallback(() => {
      setGenError(null);
    }, []);

    const setFieldValues = (values: Record<string, string>) => {
      fieldsRef.current = { ...fieldsRef.current, ...values };
      setFields(fieldsRef.current);
    };

    // Sends one field's value to the store's buffer. Commit-time cleanup (tags
    // split, single-line collapse) applies to what is stored; the textarea keeps
    // what was typed.
    const queueField = useCallback(
      (key: string, raw: string): Promise<void> => {
        const edits = { [key]: parseFieldValue(key, raw) } as EditablePostMetadata;
        const round = queuePostMetadata(postId, edits, workspaceId).then(
          (refusal) => {
            if (refusal === null) {
              delete refusedRef.current[key];
              onMetadataEditedRef.current(postId, edits);
              setGenError((prev) => (prev?.field === key ? null : prev));
            } else {
              refusedRef.current[key] = { raw, message: refusal };
            }
            syncRefusalReport();
          },
          (err: unknown) => {
            refusedRef.current[key] = {
              raw,
              message: presentFailure(
                "Metadata could not be saved. Your edit is still shown; edit the field again to retry.",
                "renderer: metadata edit queue failed",
                err,
                { postId, field: key },
              ),
            };
            syncRefusalReport();
          },
        );
        queuedRef.current[key] = round;
        return round;
      },
      [postId, workspaceId, syncRefusalReport]
    );

    // Leaving the tab takes its fields with it; the value is no longer on screen.
    useEffect(
      () => () => {
        if (!reportedRefusalRef.current) return;
        reportedRefusalRef.current = false;
        reportMetadataRefusal(postId, false);
      },
      [postId],
    );

    // The refusal for a field, when the value it refused is still the field's.
    const refusalFor = (key: string): string | null => {
      const refused = refusedRef.current[key];
      return refused && refused.raw === (fieldsRef.current[key] ?? "") ? refused.message : null;
    };

    const showFirstRefusal = (keys: string[]): boolean => {
      for (const key of keys) {
        const message = refusalFor(key);
        if (message) {
          setGenError({ message, field: key });
          return true;
        }
      }
      return false;
    };

    const stopGeneration = useCallback(() => {
      generationAbortRef.current?.abort();
      generationAbortRef.current = null;
    }, []);

    const flushPendingChanges = async (): Promise<boolean> => {
      // The caller is leaving this post: cancel generation rather than wait for
      // it. The edits themselves are already in the store's buffer; wait only
      // for the replies, so a refused value is reported before the post goes.
      stopGeneration();
      await Promise.all(Object.values(queuedRef.current));
      return !showFirstRefusal(Object.keys(refusedRef.current));
    };

    const flushPendingChangesRef = useRef(flushPendingChanges);
    flushPendingChangesRef.current = flushPendingChanges;

    useImperativeHandle(
      ref,
      () => ({
        flushPendingChanges: () => flushPendingChangesRef.current(),
      }),
      []
    );

    // A generation's result has nowhere to go once the tab is gone.
    useEffect(() => stopGeneration, [stopGeneration]);

    const updateField = (key: string, value: string) => {
      if (readOnly) return;
      setFieldValues({ [key]: value });
      void queueField(key, value);
    };

    // Blur is where a refused value is reported: while typing, a slug passes
    // through values another post uses, and flagging each would only flicker.
    const flushField = (key: string) => {
      if (readOnly) return;
      void (async () => {
        await queuedRef.current[key];
        showFirstRefusal([key]);
      })();
    };

    // Shows generated values and queues them like typed ones, then reports a
    // value the store refused (a generated slug another post already uses).
    const applyGenerated = async (values: Record<string, string>) => {
      const keys = Object.keys(values);
      if (keys.length === 0) return;
      setFieldValues(values);
      await Promise.all(keys.map((key) => queueField(key, values[key])));
      showFirstRefusal(keys);
    };

    const runGeneration = async (key: string) => {
      if (generationLockRef.current) return;
      generationLockRef.current = true;
      const controller = new AbortController();
      generationAbortRef.current = controller;
      const atStart = { ...fieldsRef.current };
      setGenerating((prev) => ({ ...prev, [key]: true }));
      try {
        const value = await generateMetadataField(postId, key, content, controller.signal);
        // The field stays editable while generation runs; if the user typed
        // into it meanwhile, their text wins and the result is dropped.
        await applyGenerated(untouchedGeneratedFields(atStart, fieldsRef.current, { [key]: value }));
      } catch (err) {
        if (controller.signal.aborted) return;
        showGenError(presentFailure(
          "Metadata could not be generated. Existing metadata is unchanged; try again.",
          "renderer: metadata generation failed",
          err,
          { postId, field: key },
        ));
      } finally {
        if (generationAbortRef.current === controller) generationAbortRef.current = null;
        setGenerating((prev) => ({ ...prev, [key]: false }));
        generationLockRef.current = false;
      }
    };

    const generate = async (key: string) => {
      if (readOnly || !content.trim() || generationLockRef.current) return;
      clearGenError();
      await runGeneration(key);
    };

    const isGenerating = (key: string) => !!generating[key];
    const anyGeneratingField = Object.values(generating).some(Boolean);
    const generationLocked = generatingAll || anyGeneratingField;

    const allFieldKeys: string[] = ["title"];
    if (isNonEnglish) allFieldKeys.push("titleEn");
    allFieldKeys.push("slug");
    if (isNonEnglish) allFieldKeys.push("tagsEn");
    allFieldKeys.push("tags");
    if (isNonEnglish) allFieldKeys.push("metaDescriptionEn");
    allFieldKeys.push("metaDescription");

    const generateAll = async () => {
      if (readOnly || !content.trim() || generationLockRef.current) return;
      generationLockRef.current = true;
      clearGenError();
      const controller = new AbortController();
      generationAbortRef.current = controller;
      const atStart = { ...fieldsRef.current };

      setGeneratingAll(true);
      try {
        const results = await generateMetadataFields(postId, allFieldKeys, content, controller.signal);
        const allGenerated: Record<string, string> = {};
        const failed: string[] = [];
        for (const key of allFieldKeys) {
          const result = results[key];
          if (!result || !("value" in result)) {
            failed.push(key);
            continue;
          }
          allGenerated[key] = result.value;
        }

        // The fields stay editable while generation runs; a field the user
        // typed into meanwhile keeps the typed value, and only untouched fields
        // take the generated one.
        await applyGenerated(untouchedGeneratedFields(atStart, fieldsRef.current, allGenerated));

        if (failed.length > 0) {
          showGenError(`Failed to generate: ${failed.join(", ")}`);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        showGenError(presentFailure(
          "Metadata could not be generated. Existing metadata is unchanged; try again.",
          "renderer: metadata batch generation failed",
          err,
          { postId },
        ));
      } finally {
        if (generationAbortRef.current === controller) generationAbortRef.current = null;
        setGeneratingAll(false);
        generationLockRef.current = false;
      }
    };

    return (
      <div className="metadata-tab">
        {genError && (
          <OperationalResult
            severity="error"
            className="metadata-error"
            dismissClassName="metadata-error-dismiss"
            onDismiss={clearGenError}
          >
            {genError.message}
          </OperationalResult>
        )}
        {readOnly && (
          <p className="meta-field-hint">
            Metadata is read-only.
          </p>
        )}
        <div className="metadata-generate-all-row">
          {/* While it runs, Generate All becomes its own Stop: the paid call is
              cancelled, not merely ignored. */}
          <button
            className="btn-generate-all"
            onClick={generatingAll ? stopGeneration : generateAll}
            disabled={!generatingAll && (readOnly || generationLocked || noContent)}
          >
            {generatingAll ? "Stop Generating" : "Generate All"}
          </button>
        </div>
        <MetaField
          label="Title"
          value={fields.title}
          onChange={(v) => updateField("title", v)}
          onBlur={() => flushField("title")}
          onCopy={() => copyToClipboard(fields.title, "title")}
          copied={copiedKey === "title"}
          copyError={copyErrors.title}
          onDismissCopyError={() => dismissCopyError("title")}
          onGenerate={() => generate("title")}
          generating={isGenerating("title")}
          onStop={stopGeneration}
          generateDisabled={readOnly || generationLocked || noContent}
          readOnly={readOnly}
          isActive={isActive}
        />
        {isNonEnglish && (
          <MetaField
            label="Title (English)"
            value={fields.titleEn ?? ""}
            onChange={(v) => updateField("titleEn", v)}
            onBlur={() => flushField("titleEn")}
            onCopy={() => copyToClipboard(fields.titleEn ?? "", "titleEn")}
            copied={copiedKey === "titleEn"}
            copyError={copyErrors.titleEn}
            onDismissCopyError={() => dismissCopyError("titleEn")}
            onGenerate={() => generate("titleEn")}
            generating={isGenerating("titleEn")}
            onStop={stopGeneration}
            generateDisabled={readOnly || generationLocked || noContent}
            readOnly={readOnly}
            isActive={isActive}
          />
        )}
        <MetaField
          label="Slug"
          value={fields.slug}
          onChange={(v) => updateField("slug", v)}
          onBlur={() => flushField("slug")}
          onCopy={() => copyToClipboard(fields.slug, "slug")}
          copied={copiedKey === "slug"}
          copyError={copyErrors.slug}
          onDismissCopyError={() => dismissCopyError("slug")}
          onGenerate={() => generate("slug")}
          generating={isGenerating("slug")}
          onStop={stopGeneration}
          generateDisabled={readOnly || generationLocked || noContent}
          readOnly={readOnly}
          isActive={isActive}
        />
        <MetaField
          label="Tags"
          value={fields.tags}
          onChange={(v) => updateField("tags", v)}
          onBlur={() => flushField("tags")}
          onCopy={() => copyToClipboard(fields.tags, "tags")}
          copied={copiedKey === "tags"}
          copyError={copyErrors.tags}
          onDismissCopyError={() => dismissCopyError("tags")}
          onGenerate={() => generate("tags")}
          generating={isGenerating("tags")}
          onStop={stopGeneration}
          generateDisabled={readOnly || generationLocked || noContent}
          placeholder="tag1, tag2, tag3"
          readOnly={readOnly}
          isActive={isActive}
        />
        {isNonEnglish && (
          <MetaField
            label="Tags (English)"
            value={fields.tagsEn ?? ""}
            onChange={(v) => updateField("tagsEn", v)}
            onBlur={() => flushField("tagsEn")}
            onCopy={() => copyToClipboard(fields.tagsEn ?? "", "tagsEn")}
            copied={copiedKey === "tagsEn"}
            copyError={copyErrors.tagsEn}
            onDismissCopyError={() => dismissCopyError("tagsEn")}
            onGenerate={() => generate("tagsEn")}
            generating={isGenerating("tagsEn")}
            onStop={stopGeneration}
            generateDisabled={readOnly || generationLocked || noContent}
            placeholder="tag1, tag2, tag3"
            readOnly={readOnly}
            isActive={isActive}
          />
        )}
        <MetaField
          label="Description"
          value={fields.metaDescription}
          onChange={(v) => updateField("metaDescription", v)}
          onBlur={() => flushField("metaDescription")}
          onCopy={() => copyToClipboard(fields.metaDescription, "metaDescription")}
          copied={copiedKey === "metaDescription"}
          copyError={copyErrors.metaDescription}
          onDismissCopyError={() => dismissCopyError("metaDescription")}
          onGenerate={() => generate("metaDescription")}
          generating={isGenerating("metaDescription")}
          onStop={stopGeneration}
          generateDisabled={readOnly || generationLocked || noContent}
          readOnly={readOnly}
          isActive={isActive}
        />
        {isNonEnglish && (
          <MetaField
            label="Description (English)"
            value={fields.metaDescriptionEn ?? ""}
            onChange={(v) => updateField("metaDescriptionEn", v)}
            onBlur={() => flushField("metaDescriptionEn")}
            onCopy={() => copyToClipboard(fields.metaDescriptionEn ?? "", "metaDescriptionEn")}
            copied={copiedKey === "metaDescriptionEn"}
            copyError={copyErrors.metaDescriptionEn}
            onDismissCopyError={() => dismissCopyError("metaDescriptionEn")}
            onGenerate={() => generate("metaDescriptionEn")}
            generating={isGenerating("metaDescriptionEn")}
            onStop={stopGeneration}
            generateDisabled={readOnly || generationLocked || noContent}
            readOnly={readOnly}
            isActive={isActive}
          />
        )}
        <MetaField
          label="Extra"
          value={fields.extra}
          onChange={(v) => updateField("extra", v)}
          onBlur={() => flushField("extra")}
          onCopy={() => copyToClipboard(fields.extra, "extra")}
          copied={copiedKey === "extra"}
          copyError={copyErrors.extra}
          onDismissCopyError={() => dismissCopyError("extra")}
          placeholder={extraFieldWatermark}
          readOnly={readOnly}
          isActive={isActive}
        />
      </div>
    );
  }
);

function MetaField({
  label,
  value,
  onChange,
  onBlur,
  onCopy,
  copied,
  copyError,
  onDismissCopyError,
  onGenerate,
  onStop,
  generating,
  generateDisabled,
  placeholder,
  readOnly,
  isActive,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  onCopy: () => void;
  copied?: boolean;
  copyError?: string;
  onDismissCopyError: () => void;
  onGenerate?: () => void;
  onStop?: () => void;
  generating?: boolean;
  generateDisabled?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  isActive?: boolean;
}) {
  return (
    <div className="meta-field">
      <div className="meta-field-header">
        <label className="meta-field-label">{label}</label>
        <div className="meta-field-actions">
          {onGenerate && (
            <button
              className="meta-field-generate"
              onClick={generating ? onStop : onGenerate}
              disabled={!generating && generateDisabled}
              title={generating ? "Stop generating" : "Generate with AI"}
            >
              {generating ? "Stop" : "Generate"}
            </button>
          )}
          <button className="meta-field-copy" onClick={onCopy} title="Copy to clipboard">
            {copied ? (
              <>
                <CheckIcon /> Copied
              </>
            ) : (
              "Copy"
            )}
          </button>
        </div>
      </div>
      {copyError && (
        <OperationalResult
          severity="error"
          className="metadata-error metadata-copy-error"
          dismissClassName="metadata-error-dismiss"
          onDismiss={onDismissCopyError}
        >
          {copyError}
        </OperationalResult>
      )}
      <AutoGrowTextarea
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        readOnly={readOnly}
        isActive={isActive}
      />
    </div>
  );
}

function AutoGrowTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  readOnly,
  isActive,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  placeholder?: string;
  readOnly?: boolean;
  isActive?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    if (!isActive) return;
    resize();
  }, [isActive, resize, value]);

  return (
    <textarea
      ref={ref}
      className="meta-field-input meta-field-textarea"
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        resize();
      }}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={1}
      readOnly={readOnly}
    />
  );
}
