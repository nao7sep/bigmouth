import { useEffect, useRef, useState } from "react";
import type { Post, PostFrontMatter, Target } from "../types";
import { updatePost, generateMetadata, generateMetadataBatch } from "../api";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

interface MetadataTabProps {
  workspaceId: string;
  postId: string;
  frontMatter: PostFrontMatter;
  target: Target | null;
  content: string;
  extraFieldWatermark: string;
  onPostUpdated: (post: Post) => void;
}

export function MetadataTab({
  workspaceId,
  postId,
  frontMatter,
  target,
  content,
  extraFieldWatermark,
  onPostUpdated,
}: MetadataTabProps) {
  const requiresMetadata = target?.requiresMetadata ?? false;
  const lang = frontMatter.language;
  const isNonEnglish = lang !== "en";
  const noContent = !content.trim();

  const [fields, setFields] = useState(() => extractFields(frontMatter));
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  const [generatingAll, setGeneratingAll] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const genErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const { copiedKey, copy: copyToClipboard } = useCopyFeedback();
  const fieldsRef = useRef(fields);
  const onPostUpdatedRef = useRef(onPostUpdated);

  useEffect(() => {
    setFields(extractFields(frontMatter));
  }, [frontMatter]);

  useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  useEffect(() => {
    onPostUpdatedRef.current = onPostUpdated;
  }, [onPostUpdated]);

  const showGenError = (msg: string) => {
    setGenError(msg);
    if (genErrorTimer.current) clearTimeout(genErrorTimer.current);
    genErrorTimer.current = setTimeout(() => setGenError(null), 8000);
  };

  // Flush pending field saves on unmount so post/workspace switches do not drop them.
  useEffect(() => {
    return () => {
      if (genErrorTimer.current) clearTimeout(genErrorTimer.current);
      for (const [key, timer] of Object.entries(saveTimers.current)) {
        clearTimeout(timer);
        delete saveTimers.current[key];
        const value = parseFieldValue(key, fieldsRef.current[key] ?? "");
        updatePost(postId, {
          frontMatter: { [key]: value },
        }, workspaceId)
          .then((updated) => onPostUpdatedRef.current(updated))
          .catch(() => {});
      }
    };
  }, [postId, workspaceId]);

  const saveField = async (
    key: string,
    value: string | string[],
    notify = true
  ) => {
    try {
      const updated = await updatePost(postId, {
        frontMatter: { [key]: value },
      }, workspaceId);
      if (!notify) return;
      onPostUpdated(updated);
    } catch {
      // Save failed
    }
  };

  const flushSave = (key: string, value: string, isTags: boolean) => {
    if (saveTimers.current[key]) { clearTimeout(saveTimers.current[key]); delete saveTimers.current[key]; }
    void saveField(key, normalizeFieldValue(value, isTags));
  };

  const updateField = (key: string, value: string, isTags = false) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    if (saveTimers.current[key]) clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = setTimeout(() => {
      delete saveTimers.current[key];
      void saveField(key, normalizeFieldValue(value, isTags));
    }, 1_000);
  };

  const generate = async (key: string, isTags = false) => {
    if (!content.trim()) return;
    setGenerating((prev) => ({ ...prev, [key]: true }));
    try {
      const value = await generateMetadata(postId, key, content);
      if (saveTimers.current[key]) { clearTimeout(saveTimers.current[key]); delete saveTimers.current[key]; }
      setFields((prev) => ({ ...prev, [key]: value }));
      await saveField(key, normalizeFieldValue(value, isTags));
    } catch (err) {
      showGenError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating((prev) => ({ ...prev, [key]: false }));
    }
  };

  const isGenerating = (key: string) => !!generating[key];

  const anyGenerating = generatingAll || Object.values(generating).some(Boolean);

  if (!requiresMetadata) {
    return (
      <div className="metadata-tab">
        {genError && (
          <div className="metadata-error">
            {genError}
            <button className="metadata-error-dismiss" onClick={() => setGenError(null)}>×</button>
          </div>
        )}
        <MetaField
          label="Slug"
          value={fields.slug}
          onChange={(v) => updateField("slug", v)}
          onBlur={() => flushSave("slug", fields.slug, false)}
          onCopy={() => copyToClipboard(fields.slug, 'slug')}
          copied={copiedKey === 'slug'}
          onGenerate={() => generate("slug")}
          generating={isGenerating("slug")}
          generateDisabled={anyGenerating || noContent}
        />
        {fields.slug && /[^a-z0-9-]/.test(fields.slug) && (
          <p className="meta-field-hint">Slug contains characters that may not be URL-safe.</p>
        )}
      </div>
    );
  }

  // Generate All covers every generatable field for this post.
  const allFields: Array<{ key: string; isTags?: boolean }> = [
    { key: "title" },
  ];
  if (isNonEnglish) allFields.push({ key: "titleEn" });
  allFields.push({ key: "slug" });
  if (isNonEnglish) allFields.push({ key: "tagsEn", isTags: true });
  allFields.push({ key: "tags", isTags: true });
  if (isNonEnglish) allFields.push({ key: "metaDescriptionEn" });
  allFields.push({ key: "metaDescription" });

  const generateAll = async () => {
    if (!content.trim()) return;
    const fieldKeys = allFields.map((f) => f.key);
    for (const key of fieldKeys) {
      if (saveTimers.current[key]) { clearTimeout(saveTimers.current[key]); delete saveTimers.current[key]; }
    }
    setGeneratingAll(true);
    try {
      const results = await generateMetadataBatch(postId, fieldKeys, content);
      const failed: string[] = [];
      for (const { key, isTags } of allFields) {
        const result = results[key];
        if (!result || "error" in result) {
          failed.push(key);
          continue;
        }
        const value = result.value;
        setFields((prev) => ({ ...prev, [key]: value }));
        await saveField(key, normalizeFieldValue(value, !!isTags));
      }
      if (failed.length > 0) {
        showGenError(`Failed to generate: ${failed.join(", ")}`);
      }
    } catch (err) {
      showGenError(err instanceof Error ? err.message : "Batch generation failed");
    } finally {
      setGeneratingAll(false);
    }
  };

  return (
    <div className="metadata-tab">
      {genError && (
        <div className="metadata-error">
          {genError}
          <button className="metadata-error-dismiss" onClick={() => setGenError(null)}>×</button>
        </div>
      )}
      <div className="metadata-generate-all-row">
        <button
          className="btn-generate-all"
          onClick={generateAll}
          disabled={anyGenerating || noContent}
        >
          {generatingAll ? "Generating All…" : "Generate All"}
        </button>
      </div>
      <MetaField
        label="Title"
        value={fields.title}
        onChange={(v) => updateField("title", v)}
        onBlur={() => flushSave("title", fields.title, false)}
        onCopy={() => copyToClipboard(fields.title, 'title')}
        copied={copiedKey === 'title'}
        onGenerate={() => generate("title")}
        generating={isGenerating("title")}
        generateDisabled={anyGenerating || noContent}
      />
      {isNonEnglish && (
        <MetaField
          label="Title (English)"
          value={fields.titleEn ?? ""}
          onChange={(v) => updateField("titleEn", v)}
          onBlur={() => flushSave("titleEn", fields.titleEn ?? "", false)}
          onCopy={() => copyToClipboard(fields.titleEn ?? "", 'titleEn')}
          copied={copiedKey === 'titleEn'}
          onGenerate={() => generate("titleEn")}
          generating={isGenerating("titleEn")}
          generateDisabled={anyGenerating || noContent}
        />
      )}
      <MetaField
        label="Slug"
        value={fields.slug}
        onChange={(v) => updateField("slug", v)}
        onBlur={() => flushSave("slug", fields.slug, false)}
        onCopy={() => copyToClipboard(fields.slug, 'slug')}
        copied={copiedKey === 'slug'}
        onGenerate={() => generate("slug")}
        generating={isGenerating("slug")}
        generateDisabled={anyGenerating || noContent}
      />

      <MetaField
        label="Tags"
        value={fields.tags}
        onChange={(v) => updateField("tags", v, true)}
        onBlur={() => flushSave("tags", fields.tags, true)}
        onCopy={() => copyToClipboard(fields.tags, 'tags')}
        copied={copiedKey === 'tags'}
        onGenerate={() => generate("tags", true)}
        generating={isGenerating("tags")}
        generateDisabled={anyGenerating || noContent}
        placeholder="tag1, tag2, tag3"
      />
      {isNonEnglish && (
        <MetaField
          label="Tags (English)"
          value={fields.tagsEn ?? ""}
          onChange={(v) => updateField("tagsEn", v, true)}
          onBlur={() => flushSave("tagsEn", fields.tagsEn ?? "", true)}
          onCopy={() => copyToClipboard(fields.tagsEn ?? "", 'tagsEn')}
          copied={copiedKey === 'tagsEn'}
          onGenerate={() => generate("tagsEn", true)}
          generating={isGenerating("tagsEn")}
          generateDisabled={anyGenerating || noContent}
          placeholder="tag1, tag2, tag3"
        />
      )}
      <MetaField
        label="Description"
        value={fields.metaDescription}
        onChange={(v) => updateField("metaDescription", v)}
        onBlur={() => flushSave("metaDescription", fields.metaDescription, false)}
        onCopy={() => copyToClipboard(fields.metaDescription, 'metaDescription')}
        copied={copiedKey === 'metaDescription'}
        onGenerate={() => generate("metaDescription")}
        generating={isGenerating("metaDescription")}
        generateDisabled={anyGenerating || noContent}
        multiline
      />
      {isNonEnglish && (
        <MetaField
          label="Description (English)"
          value={fields.metaDescriptionEn ?? ""}
          onChange={(v) => updateField("metaDescriptionEn", v)}
          onBlur={() => flushSave("metaDescriptionEn", fields.metaDescriptionEn ?? "", false)}
          onCopy={() => copyToClipboard(fields.metaDescriptionEn ?? "", 'metaDescriptionEn')}
          copied={copiedKey === 'metaDescriptionEn'}
          onGenerate={() => generate("metaDescriptionEn")}
          generating={isGenerating("metaDescriptionEn")}
          generateDisabled={anyGenerating || noContent}
          multiline
        />
      )}
      <MetaField
        label="Extra"
        value={fields.extra}
        onChange={(v) => updateField("extra", v)}
        onBlur={() => flushSave("extra", fields.extra, false)}
        onCopy={() => copyToClipboard(fields.extra, 'extra')}
        copied={copiedKey === 'extra'}
        multiline
        placeholder={extraFieldWatermark}
      />
    </div>
  );
}

// --- MetaField sub-component ---

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
  multiline,
  placeholder,
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
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="meta-field">
      <div className="meta-field-header">
        <label className="meta-field-label">{label}</label>
        <div className="meta-field-actions">
          <button
            className="meta-field-copy"
            onClick={onCopy}
            title="Copy to clipboard"
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
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
        </div>
      </div>
      {multiline ? (
        <textarea
          className="meta-field-input meta-field-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          rows={3}
        />
      ) : (
        <input
          className="meta-field-input"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}

// --- Helpers ---

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
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

function parseFieldValue(key: string, value: string): string | string[] {
  return normalizeFieldValue(value, key === "tags" || key === "tagsEn");
}
