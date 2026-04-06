import { useEffect, useRef, useState } from "react";
import type { PostFrontMatter, Target } from "../types";
import { updatePost, generateMetadata, generateMetadataBatch } from "../api";
import { useCopyFeedback } from "../hooks/useCopyFeedback";

interface MetadataTabProps {
  postId: string;
  frontMatter: PostFrontMatter;
  target: Target | null;
  extraFieldWatermark: string;
  onMetadataSaved: () => void;
}

export function MetadataTab({
  postId,
  frontMatter,
  target,
  extraFieldWatermark,
  onMetadataSaved,
}: MetadataTabProps) {
  const requiresMetadata = target?.requiresMetadata ?? false;
  const lang = frontMatter.language;
  const isNonEnglish = lang !== "en";

  const [fields, setFields] = useState(() => extractFields(frontMatter));
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  const [genError, setGenError] = useState<string | null>(null);
  const genErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { copiedKey, copy: copyToClipboard } = useCopyFeedback();

  const showGenError = (msg: string) => {
    setGenError(msg);
    if (genErrorTimer.current) clearTimeout(genErrorTimer.current);
    genErrorTimer.current = setTimeout(() => setGenError(null), 8000);
  };

  useEffect(() => {
    setFields(extractFields(frontMatter));
  }, [frontMatter, lang]);

  const saveField = async (key: string, value: string | string[]) => {
    try {
      await updatePost(postId, {
        frontMatter: { [key]: value || undefined },
      });
      onMetadataSaved();
    } catch {
      // Save failed
    }
  };

  const handleBlur = (key: string, value: string) => {
    const current = (frontMatter as Record<string, unknown>)[key] ?? "";
    if (value !== current) saveField(key, value);
  };

  const handleTagsBlur = (key: string, value: string) => {
    const tags = value.split(",").map((t) => t.trim()).filter(Boolean);
    const current = (frontMatter as Record<string, unknown>)[key];
    const currentStr = Array.isArray(current) ? current.join(", ") : "";
    if (value !== currentStr) saveField(key, tags);
  };

  const updateField = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const generate = async (key: string, isTags = false) => {
    setGenerating((prev) => ({ ...prev, [key]: true }));
    try {
      const value = await generateMetadata(postId, key);
      updateField(key, value);
      if (isTags) {
        const tags = value.split(",").map((t) => t.trim()).filter(Boolean);
        await saveField(key, tags);
      } else {
        await saveField(key, value);
      }
    } catch (err) {
      showGenError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating((prev) => ({ ...prev, [key]: false }));
    }
  };

  const isGenerating = (key: string) => !!generating[key];

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
          onBlur={() => handleBlur("slug", fields.slug)}
          onCopy={() => copyToClipboard(fields.slug, 'slug')}
          copied={copiedKey === 'slug'}
          onGenerate={() => generate("slug")}
          generating={isGenerating("slug")}
        />
      </div>
    );
  }

  // "Generate All" covers only the fields below the divider: tags and
  // metaDescription (plus their English variants). Title and slug sit above
  // the divider and have individual Gen buttons; they are intentionally excluded
  // here to prevent overwriting carefully edited values.
  const allFields: Array<{ key: string; isTags?: boolean }> = [];
  if (isNonEnglish) allFields.push({ key: "tagsEn", isTags: true });
  allFields.push({ key: "tags", isTags: true });
  if (isNonEnglish) allFields.push({ key: "metaDescriptionEn" });
  allFields.push({ key: "metaDescription" });

  const anyGenerating = Object.values(generating).some(Boolean);

  const generateAll = async () => {
    const fieldKeys = allFields.map((f) => f.key);
    // Mark all as generating
    setGenerating((prev) => {
      const next = { ...prev };
      for (const key of fieldKeys) next[key] = true;
      return next;
    });
    try {
      const results = await generateMetadataBatch(postId, fieldKeys);
      const failed: string[] = [];
      for (const { key, isTags } of allFields) {
        const result = results[key];
        if (!result || "error" in result) {
          failed.push(key);
          continue;
        }
        const value = result.value;
        updateField(key, value);
        if (isTags) {
          const tags = value.split(",").map((t) => t.trim()).filter(Boolean);
          await saveField(key, tags);
        } else {
          await saveField(key, value);
        }
      }
      if (failed.length > 0) {
        showGenError(`Failed to generate: ${failed.join(", ")}`);
      }
    } catch (err) {
      showGenError(err instanceof Error ? err.message : "Batch generation failed");
    } finally {
      setGenerating((prev) => {
        const next = { ...prev };
        for (const key of fieldKeys) next[key] = false;
        return next;
      });
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
      <MetaField
        label="Title"
        value={fields.title}
        onChange={(v) => updateField("title", v)}
        onBlur={() => handleBlur("title", fields.title)}
        onCopy={() => copyToClipboard(fields.title, 'title')}
          copied={copiedKey === 'title'}
        onGenerate={() => generate("title")}
        generating={isGenerating("title")}
      />
      {isNonEnglish && (
        <MetaField
          label="Title (en)"
          value={fields.titleEn ?? ""}
          onChange={(v) => updateField("titleEn", v)}
          onBlur={() => handleBlur("titleEn", fields.titleEn ?? "")}
          onCopy={() => copyToClipboard(fields.titleEn ?? "", 'titleEn')}
          copied={copiedKey === 'titleEn'}
          onGenerate={() => generate("titleEn")}
          generating={isGenerating("titleEn")}
        />
      )}
      <MetaField
        label="Slug"
        value={fields.slug}
        onChange={(v) => updateField("slug", v)}
        onBlur={() => handleBlur("slug", fields.slug)}
        onCopy={() => copyToClipboard(fields.slug, 'slug')}
          copied={copiedKey === 'slug'}
        onGenerate={() => generate("slug")}
        generating={isGenerating("slug")}
      />

      <div className="metadata-divider">
        <button
          className="btn-generate-all"
          onClick={generateAll}
          disabled={anyGenerating}
        >
          {anyGenerating ? "Generating…" : "Generate All"}
        </button>
      </div>

      <MetaField
        label="Tags"
        value={fields.tags}
        onChange={(v) => updateField("tags", v)}
        onBlur={() => handleTagsBlur("tags", fields.tags)}
        onCopy={() => copyToClipboard(fields.tags, 'tags')}
          copied={copiedKey === 'tags'}
        onGenerate={() => generate("tags", true)}
        generating={isGenerating("tags")}
        placeholder="tag1, tag2, tag3"
      />
      {isNonEnglish && (
        <MetaField
          label="Tags (en)"
          value={fields.tagsEn ?? ""}
          onChange={(v) => updateField("tagsEn", v)}
          onBlur={() => handleTagsBlur("tagsEn", fields.tagsEn ?? "")}
          onCopy={() => copyToClipboard(fields.tagsEn ?? "", 'tagsEn')}
          copied={copiedKey === 'tagsEn'}
          onGenerate={() => generate("tagsEn", true)}
          generating={isGenerating("tagsEn")}
          placeholder="tag1, tag2, tag3"
        />
      )}
      <MetaField
        label="Description"
        value={fields.metaDescription}
        onChange={(v) => updateField("metaDescription", v)}
        onBlur={() => handleBlur("metaDescription", fields.metaDescription)}
        onCopy={() => copyToClipboard(fields.metaDescription, 'metaDescription')}
          copied={copiedKey === 'metaDescription'}
        onGenerate={() => generate("metaDescription")}
        generating={isGenerating("metaDescription")}
        multiline
      />
      {isNonEnglish && (
        <MetaField
          label="Description (en)"
          value={fields.metaDescriptionEn ?? ""}
          onChange={(v) => updateField("metaDescriptionEn", v)}
          onBlur={() => handleBlur("metaDescriptionEn", fields.metaDescriptionEn ?? "")}
          onCopy={() => copyToClipboard(fields.metaDescriptionEn ?? "", 'metaDescriptionEn')}
          copied={copiedKey === 'metaDescriptionEn'}
          onGenerate={() => generate("metaDescriptionEn")}
          generating={isGenerating("metaDescriptionEn")}
          multiline
        />
      )}
      <MetaField
        label="Extra"
        value={fields.extra}
        onChange={(v) => updateField("extra", v)}
        onBlur={() => handleBlur("extra", fields.extra)}
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
  multiline?: boolean;
  placeholder?: string;
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
              disabled={generating}
              title="Generate with AI"
            >
              {generating ? "…" : "Gen"}
            </button>
          )}
          <button
            className="meta-field-copy"
            onClick={onCopy}
            title="Copy to clipboard"
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
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
