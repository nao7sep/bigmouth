import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Post, PostFrontMatter, Target } from "../types";
import { updatePost, generateMetadataField, generateMetadataFields } from "../api";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

interface MetadataTabProps {
  workspaceId: string;
  postId: string;
  frontMatter: PostFrontMatter;
  target: Target | null;
  content: string;
  extraFieldWatermark: string;
  onPostUpdated: (post: Post) => void;
  isActive?: boolean;
  readOnly?: boolean;
}

export interface MetadataTabHandle {
  flushPendingChanges: () => Promise<boolean>;
}

export const MetadataTab = forwardRef<MetadataTabHandle, MetadataTabProps>(
  function MetadataTab(
    {
      workspaceId,
      postId,
      frontMatter,
      target,
      content,
      extraFieldWatermark,
      onPostUpdated,
      isActive = false,
      readOnly = false,
    },
    ref
  ) {
    const requiresMetadata = target?.requiresMetadata ?? false;
    const lang = frontMatter.language;
    const isNonEnglish = lang !== "en";
    const noContent = !content.trim();

    const [fields, setFields] = useState(() => extractFields(frontMatter));
    const [generating, setGenerating] = useState<Record<string, boolean>>({});
    const [generatingAll, setGeneratingAll] = useState(false);
    const [genError, setGenError] = useState<string | null>(null);
    const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
    const dirtyKeysRef = useRef<Set<string>>(new Set());
    const generationLockRef = useRef(false);
    const generationPromisesRef = useRef<Set<Promise<unknown>>>(new Set());
    const { copiedKey, copy: copyToClipboard } = useCopyFeedback();
    const fieldsRef = useRef(fields);
    const onPostUpdatedRef = useRef(onPostUpdated);

    useEffect(() => {
      const nextFields = extractFields(frontMatter);
      setFields((prev) => {
        const merged = { ...nextFields };
        for (const key of dirtyKeysRef.current) {
          if (Object.prototype.hasOwnProperty.call(prev, key)) {
            merged[key] = prev[key];
          }
        }
        return merged;
      });
    }, [frontMatter]);

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

    const clearDirtyKey = (key: string) => {
      dirtyKeysRef.current.delete(key);
    };

    const markDirtyKey = (key: string) => {
      dirtyKeysRef.current.add(key);
    };

    const saveField = useCallback(
      async (key: string, value: string | string[], notify = true): Promise<boolean> => {
        try {
          const updated = await updatePost(
            postId,
            {
              frontMatter: { [key]: value },
            },
            workspaceId
          );
          clearDirtyKey(key);
          if (notify) {
            onPostUpdatedRef.current(updated);
          }
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

      const pendingKeys = new Set<string>([
        ...Object.keys(saveTimers.current),
        ...dirtyKeysRef.current,
      ]);
      for (const key of Object.keys(saveTimers.current)) {
        clearTimeout(saveTimers.current[key]);
        delete saveTimers.current[key];
      }

      let ok = true;
      for (const key of pendingKeys) {
        const value = parseFieldValue(key, fieldsRef.current[key] ?? "");
        const saved = await saveField(key, value);
        if (!saved) ok = false;
      }
      return ok;
    }, [saveField]);

    useImperativeHandle(
      ref,
      () => ({
        flushPendingChanges,
      }),
      [flushPendingChanges]
    );

    useEffect(() => {
      return () => {
        const pendingKeys = new Set<string>([
          ...Object.keys(saveTimers.current),
          ...dirtyKeysRef.current,
        ]);
        for (const timer of Object.values(saveTimers.current)) {
          clearTimeout(timer);
        }
        saveTimers.current = {};

        for (const key of pendingKeys) {
          const value = parseFieldValue(key, fieldsRef.current[key] ?? "");
          void updatePost(
            postId,
            {
              frontMatter: { [key]: value },
            },
            workspaceId
          )
            .then((updated) => {
              clearDirtyKey(key);
              onPostUpdatedRef.current(updated);
            })
            .catch(() => {});
        }
      };
    }, [postId, workspaceId]);

    const flushSave = (key: string, value: string, isTags: boolean) => {
      if (readOnly) return;
      if (saveTimers.current[key]) {
        clearTimeout(saveTimers.current[key]);
        delete saveTimers.current[key];
      }
      markDirtyKey(key);
      void saveField(key, normalizeFieldValue(value, isTags));
    };

    const updateField = (key: string, value: string, isTags = false) => {
      if (readOnly) return;
      markDirtyKey(key);
      setFields((prev) => ({ ...prev, [key]: value }));
      if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
      saveTimers.current[key] = setTimeout(() => {
        delete saveTimers.current[key];
        void saveField(key, normalizeFieldValue(value, isTags));
      }, 1_000);
    };

    const runGeneration = useCallback(
      (key: string, isTags = false) => {
        const task = (async () => {
          if (generationLockRef.current) {
            return { key, ok: false as const, skipped: true as const };
          }
          generationLockRef.current = true;
          setGenerating((prev) => ({ ...prev, [key]: true }));
          try {
            const value = await generateMetadataField(postId, key, content);
            if (saveTimers.current[key]) {
              clearTimeout(saveTimers.current[key]);
              delete saveTimers.current[key];
            }
            markDirtyKey(key);
            setFields((prev) => ({ ...prev, [key]: value }));
            await saveField(key, normalizeFieldValue(value, isTags));
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
      [content, postId, saveField, showGenError]
    );

    const generate = async (key: string, isTags = false) => {
      if (readOnly || !content.trim() || generationLockRef.current) return;
      clearGenError();
      await runGeneration(key, isTags);
    };

    const isGenerating = (key: string) => !!generating[key];
    const anyGeneratingField = Object.values(generating).some(Boolean);
    const generationLocked = generatingAll || anyGeneratingField;

    if (!requiresMetadata) {
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
          <MetaField
            label="Slug"
            value={fields.slug}
            onChange={(v) => updateField("slug", v)}
            onBlur={() => flushSave("slug", fields.slug, false)}
            onCopy={() => copyToClipboard(fields.slug, "slug")}
            copied={copiedKey === "slug"}
            onGenerate={() => generate("slug")}
            generating={isGenerating("slug")}
            generateDisabled={readOnly || generationLocked || noContent}
            readOnly={readOnly}
            isActive={isActive}
          />
          {fields.slug && /[^a-z0-9-]/.test(fields.slug) && (
            <p className="meta-field-hint">Slug contains characters that may not be URL-safe.</p>
          )}
        </div>
      );
    }

    const allFields: Array<{ key: string; isTags?: boolean }> = [{ key: "title" }];
    if (isNonEnglish) allFields.push({ key: "titleEn" });
    allFields.push({ key: "slug" });
    if (isNonEnglish) allFields.push({ key: "tagsEn", isTags: true });
    allFields.push({ key: "tags", isTags: true });
    if (isNonEnglish) allFields.push({ key: "metaDescriptionEn" });
    allFields.push({ key: "metaDescription" });

    const generateAll = async () => {
      if (readOnly || !content.trim() || generationLockRef.current) return;
      generationLockRef.current = true;
      clearGenError();
      const task = (async () => {
        const fieldKeys = allFields.map((f) => f.key);
        for (const key of fieldKeys) {
          if (saveTimers.current[key]) {
            clearTimeout(saveTimers.current[key]);
            delete saveTimers.current[key];
          }
        }

        setGeneratingAll(true);
        try {
          const results = await generateMetadataFields(postId, fieldKeys, content);
          const generatedFields: Record<string, string> = {};
          const frontMatterPatch = {} as {
            [K in keyof Post["frontMatter"]]?: Post["frontMatter"][K] | null;
          };
          const savedKeys: string[] = [];
          const failed: string[] = [];

          for (const { key, isTags } of allFields) {
            const result = results[key];
            if (!result || !("value" in result)) {
              failed.push(key);
              continue;
            }

            generatedFields[key] = result.value;
            (frontMatterPatch as Record<string, string | string[]>)[key] =
              normalizeFieldValue(result.value, !!isTags);
            savedKeys.push(key);
          }

          if (savedKeys.length > 0) {
            for (const key of savedKeys) markDirtyKey(key);
            setFields((prev) => ({ ...prev, ...generatedFields }));
            try {
              const updated = await updatePost(
                postId,
                { frontMatter: frontMatterPatch },
                workspaceId
              );
              for (const key of savedKeys) clearDirtyKey(key);
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
            Published posts are read-only. Move back to Ready to edit.
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
          onBlur={() => flushSave("title", fields.title, false)}
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
            onBlur={() => flushSave("titleEn", fields.titleEn ?? "", false)}
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
          onBlur={() => flushSave("slug", fields.slug, false)}
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
          onChange={(v) => updateField("tags", v, true)}
          onBlur={() => flushSave("tags", fields.tags, true)}
          onCopy={() => copyToClipboard(fields.tags, "tags")}
          copied={copiedKey === "tags"}
          onGenerate={() => generate("tags", true)}
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
            onChange={(v) => updateField("tagsEn", v, true)}
            onBlur={() => flushSave("tagsEn", fields.tagsEn ?? "", true)}
            onCopy={() => copyToClipboard(fields.tagsEn ?? "", "tagsEn")}
            copied={copiedKey === "tagsEn"}
            onGenerate={() => generate("tagsEn", true)}
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
          onBlur={() => flushSave("metaDescription", fields.metaDescription, false)}
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
            onBlur={() => flushSave("metaDescriptionEn", fields.metaDescriptionEn ?? "", false)}
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
          onBlur={() => flushSave("extra", fields.extra, false)}
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
            {copied ? "✓ Copied" : "Copy"}
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

function normalizeFieldValue(value: string, isTags: boolean): string | string[] {
  if (!isTags) return value;
  return value
    .split(/[,\u3001]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function parseFieldValue(key: string, value: string): string | string[] {
  return normalizeFieldValue(value, key === "tags" || key === "tagsEn");
}
