import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Post, PostFrontMatter, PostMutationResult } from "@shared/types";
import { updatePost, generateMetadataField, generateMetadataFields } from "../api";
import { useCopyFeedback } from "../hooks/useCopyFeedback";
import { singleLine } from "../util/textCleanup";

interface MetadataTabProps {
  workspaceId: string;
  postId: string;
  frontMatter: PostFrontMatter;
  content: string;
  extraFieldWatermark: string;
  onPostUpdated: (result: PostMutationResult) => void;
  isActive?: boolean;
  readOnly?: boolean;
}

export interface MetadataTabHandle {
  flushPendingChanges: () => Promise<boolean>;
}

const AUTOSAVE_DELAY_MS = 1_000;

export const MetadataTab = forwardRef<MetadataTabHandle, MetadataTabProps>(
  function MetadataTab(
    {
      workspaceId,
      postId,
      frontMatter,
      content,
      extraFieldWatermark,
      onPostUpdated,
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
    // remounts for each post and seeds from front matter exactly once; it is
    // also the only writer of these fields, so server echoes never need to be
    // merged back in.
    const [fields, setFields] = useState(() => extractFields(frontMatter));
    const [generating, setGenerating] = useState<Record<string, boolean>>({});
    const [generatingAll, setGeneratingAll] = useState(false);
    const [genError, setGenError] = useState<string | null>(null);
    const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
    const generationLockRef = useRef(false);
    const generationPromisesRef = useRef<Set<Promise<unknown>>>(new Set());
    const { copiedKey, copy: copyToClipboard } = useCopyFeedback();
    const fieldsRef = useRef(fields);
    // The value last confirmed saved for each field, in the same
    // raw string form as `fields` and seeded from the same front matter, so
    // nothing starts dirty. A field is dirty exactly when its current value
    // differs from this snapshot. Deriving dirtiness from one saved snapshot —
    // rather than juggling a separate dirty set across every save path — is what
    // keeps the debounce, blur, generation, and flush paths consistent: a value
    // typed while a save is in flight simply differs from what we recorded and
    // stays dirty, with no per-path guard to forget.
    const savedRef = useRef<Record<string, string>>({ ...fields });
    const onPostUpdatedRef = useRef(onPostUpdated);

    useEffect(() => {
      fieldsRef.current = fields;
    }, [fields]);

    useEffect(() => {
      onPostUpdatedRef.current = onPostUpdated;
    }, [onPostUpdated]);

    const showGenError = useCallback((msg: string) => {
      setGenError(msg);
    }, []);

    const clearGenError = useCallback(() => {
      setGenError(null);
    }, []);

    const clearTimer = (key: string) => {
      const timer = saveTimers.current[key];
      if (timer) {
        clearTimeout(timer);
        delete saveTimers.current[key];
      }
    };

    // A field is dirty when its current value differs from the last value we
    // confirmed saved. Both refs hold raw strings, so the comparison is exact
    // (no parse round-trip) and tag normalization never makes a field look
    // perpetually unsaved.
    const isDirty = useCallback(
      (key: string) => (fieldsRef.current[key] ?? "") !== (savedRef.current[key] ?? ""),
      []
    );

    const dirtyKeys = useCallback(
      () => Object.keys(fieldsRef.current).filter((key) => isDirty(key)),
      [isDirty]
    );

    // Persists one field. `rawValue` is supplied only by generation, where the
    // generated value has not yet propagated into fieldsRef; all other callers
    // read the latest typed value from fieldsRef.
    const persistField = useCallback(
      async (key: string, rawValue?: string): Promise<boolean> => {
        const raw = rawValue ?? fieldsRef.current[key] ?? "";
        const value = parseFieldValue(key, raw);
        try {
          const updated = await updatePost(postId, { frontMatter: { [key]: value } }, workspaceId);
          // Record exactly what we persisted. Because dirtiness is derived from
          // this snapshot, a value the user typed while the save was in flight
          // still differs from `raw` and stays dirty — the newer value is never
          // mistaken for saved, and the next debounce or flush picks it up.
          savedRef.current[key] = raw;
          onPostUpdatedRef.current(updated);
          return true;
        } catch (err) {
          showGenError(err instanceof Error ? err.message : `Failed to save ${key}`);
          return false;
        }
      },
      [postId, showGenError, workspaceId]
    );

    const flushPendingChanges = useCallback(async (): Promise<boolean> => {
      while (generationPromisesRef.current.size > 0) {
        await Promise.all(Array.from(generationPromisesRef.current));
      }

      for (const key of Object.keys(saveTimers.current)) clearTimer(key);

      // Save every dirty field, then re-check: a field edited while one of these
      // saves was in flight stays dirty and must also be persisted before we
      // report success, because the caller unmounts this tab on a true result.
      // Each successful save advances the saved snapshot, so this converges; a
      // failed save stops the drain and surfaces as a false result.
      let ok = true;
      for (let pending = dirtyKeys(); pending.length > 0; pending = dirtyKeys()) {
        for (const key of pending) {
          if (!(await persistField(key))) ok = false;
        }
        if (!ok) break;
      }
      return ok;
    }, [dirtyKeys, persistField]);

    useImperativeHandle(
      ref,
      () => ({
        flushPendingChanges,
      }),
      [flushPendingChanges]
    );

    // Drop pending debounce timers on unmount so a stray save never fires after
    // the post is gone. Intentional teardowns (post switch, status change,
    // workspace switch) are flushed explicitly via flushPendingChanges first; a
    // delete deliberately discards unsaved edits.
    useEffect(() => {
      return () => {
        for (const key of Object.keys(saveTimers.current)) clearTimer(key);
      };
    }, []);

    const updateField = (key: string, value: string) => {
      if (readOnly) return;
      setFields((prev) => ({ ...prev, [key]: value }));
      clearTimer(key);
      saveTimers.current[key] = setTimeout(() => {
        delete saveTimers.current[key];
        void persistField(key);
      }, AUTOSAVE_DELAY_MS);
    };

    // Blur fast-forwards the debounce: save now instead of waiting out the timer.
    const flushField = (key: string) => {
      if (readOnly) return;
      clearTimer(key);
      if (isDirty(key)) void persistField(key);
    };

    const runGeneration = useCallback(
      (key: string) => {
        const task = (async () => {
          if (generationLockRef.current) {
            return { key, ok: false as const, skipped: true as const };
          }
          generationLockRef.current = true;
          setGenerating((prev) => ({ ...prev, [key]: true }));
          try {
            const value = await generateMetadataField(postId, key, content);
            clearTimer(key);
            setFields((prev) => ({ ...prev, [key]: value }));
            await persistField(key, value);
            return { key, ok: true as const };
          } catch (err) {
            const message = err instanceof Error ? err.message : "Generation failed";
            showGenError(message);
            return { key, ok: false as const, error: message };
          } finally {
            setGenerating((prev) => ({ ...prev, [key]: false }));
            generationLockRef.current = false;
          }
        })();

        generationPromisesRef.current.add(task);
        task.finally(() => {
          generationPromisesRef.current.delete(task);
        });
        return task;
      },
      [content, persistField, postId, showGenError]
    );

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
      const task = (async () => {
        for (const key of allFieldKeys) clearTimer(key);

        setGeneratingAll(true);
        try {
          const results = await generateMetadataFields(postId, allFieldKeys, content);
          const generatedFields: Record<string, string> = {};
          const frontMatterPatch = {} as {
            [K in keyof Post["frontMatter"]]?: Post["frontMatter"][K] | null;
          };
          const savedKeys: string[] = [];
          const failed: string[] = [];

          for (const key of allFieldKeys) {
            const result = results[key];
            if (!result || !("value" in result)) {
              failed.push(key);
              continue;
            }

            generatedFields[key] = result.value;
            (frontMatterPatch as Record<string, string | string[]>)[key] =
              parseFieldValue(key, result.value);
            savedKeys.push(key);
          }

          if (savedKeys.length > 0) {
            // setFields makes the generated values current; until the batch save
            // confirms, they differ from the saved snapshot and so read as dirty.
            setFields((prev) => ({ ...prev, ...generatedFields }));
            try {
              const updated = await updatePost(
                postId,
                { frontMatter: frontMatterPatch },
                workspaceId
              );
              // Advance the saved snapshot to the generated values. A field the
              // user edited while this save was in flight now differs and stays
              // dirty, so the edit survives for the next save instead of being
              // dropped. On failure the snapshot is untouched, so every generated
              // field stays dirty and a later flush retries it.
              for (const key of savedKeys) savedRef.current[key] = generatedFields[key];
              onPostUpdatedRef.current(updated);
            } catch (err) {
              showGenError(err instanceof Error ? err.message : "Failed to save generated metadata");
            }
          }

          if (failed.length > 0) {
            showGenError(`Failed to generate: ${failed.join(", ")}`);
          }
        } catch (err) {
          showGenError(err instanceof Error ? err.message : "Batch generation failed");
        } finally {
          setGeneratingAll(false);
          generationLockRef.current = false;
        }
      })();

      generationPromisesRef.current.add(task);
      try {
        await task;
      } finally {
        generationPromisesRef.current.delete(task);
      }
    };

    return (
      <div className="metadata-tab">
        {genError && (
          <div className="metadata-error">
            {genError}
            <button className="metadata-error-dismiss" onClick={clearGenError}>
              ×
            </button>
          </div>
        )}
        {readOnly && (
          <p className="meta-field-hint">
            Metadata is read-only.
          </p>
        )}
        <div className="metadata-generate-all-row">
            <button
              className="btn-generate-all"
              onClick={generateAll}
              disabled={readOnly || generationLocked || noContent}
            >
            {generatingAll ? "Generating All…" : "Generate All"}
          </button>
        </div>
        <MetaField
          label="Title"
          value={fields.title}
          onChange={(v) => updateField("title", v)}
          onBlur={() => flushField("title")}
          onCopy={() => copyToClipboard(fields.title, "title")}
          copied={copiedKey === "title"}
          onGenerate={() => generate("title")}
          generating={isGenerating("title")}
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
            onGenerate={() => generate("titleEn")}
            generating={isGenerating("titleEn")}
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
          onGenerate={() => generate("slug")}
          generating={isGenerating("slug")}
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
          onGenerate={() => generate("tags")}
          generating={isGenerating("tags")}
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
            onGenerate={() => generate("tagsEn")}
            generating={isGenerating("tagsEn")}
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
          onGenerate={() => generate("metaDescription")}
          generating={isGenerating("metaDescription")}
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
            onGenerate={() => generate("metaDescriptionEn")}
            generating={isGenerating("metaDescriptionEn")}
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
  onGenerate,
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
  onGenerate?: () => void;
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
              onClick={onGenerate}
              disabled={generating || generateDisabled}
              title="Generate with AI"
            >
              {generating ? "Generating…" : "Generate"}
            </button>
          )}
          <button className="meta-field-copy" onClick={onCopy} title="Copy to clipboard">
            {copied ? (
              "✓ Copied"
            ) : (
              "Copy"
            )}
          </button>
        </div>
      </div>
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

function extractFields(fm: PostFrontMatter): Record<string, string> {
  const get = (key: string) => {
    const val = (fm as Record<string, unknown>)[key];
    if (Array.isArray(val)) return val.join(", ");
    return (val as string) ?? "";
  };

  const fields: Record<string, string> = {
    title: get("title"),
    slug: get("slug"),
    tags: get("tags"),
    metaDescription: get("metaDescription"),
    extra: get("extra"),
  };

  if (fm.language !== "en") {
    fields.titleEn = get("titleEn");
    fields.tagsEn = get("tagsEn");
    fields.metaDescriptionEn = get("metaDescriptionEn");
  }

  return fields;
}

// Scalar metadata fields that are stored as a single line. They are edited in
// `<textarea>`s (which, unlike `<input>`, keep pasted newlines), so they get
// single-line cleanup at commit time \u2014 never on a keystroke. `slug` is excluded
// (server-validated, not normalized) and `extra` is excluded (free-text KVP).
const SINGLE_LINE_FIELDS = new Set(["title", "titleEn", "metaDescription", "metaDescriptionEn"]);

// Parses a raw textarea value into the form persisted in front matter, applying
// commit-time cleanup. Called only from save paths (persistField, generateAll),
// so cleanup runs on save, not while the user types.
function parseFieldValue(key: string, value: string): string | string[] {
  if (key === "tags" || key === "tagsEn") {
    return value
      .split(/[,\u3001]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (SINGLE_LINE_FIELDS.has(key)) return singleLine(value);
  return value;
}
