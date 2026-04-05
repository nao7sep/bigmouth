import { useEffect, useState } from "react";
import type { PostFrontMatter, Target } from "../types";
import { updatePost, generateMetadata } from "../api";

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

  const [fields, setFields] = useState(() => extractFields(frontMatter, lang));
  const [generating, setGenerating] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setFields(extractFields(frontMatter, lang));
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

  const copyToClipboard = (value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
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
    } catch {
      // Generation failed — leave field unchanged
    } finally {
      setGenerating((prev) => ({ ...prev, [key]: false }));
    }
  };

  const isGenerating = (key: string) => !!generating[key];

  if (!requiresMetadata) {
    return (
      <div className="metadata-tab">
        <MetaField
          label="Slug"
          value={fields.slug}
          onChange={(v) => updateField("slug", v)}
          onBlur={() => handleBlur("slug", fields.slug)}
          onCopy={() => copyToClipboard(fields.slug)}
          onGenerate={() => generate("slug")}
          generating={isGenerating("slug")}
        />
      </div>
    );
  }

  const langSuffix = lang.charAt(0).toUpperCase() + lang.slice(1);

  // Build the list of generatable fields for "Generate All"
  const allFields: Array<{ key: string; isTags?: boolean }> = [];
  if (isNonEnglish) allFields.push({ key: `title${langSuffix}` });
  allFields.push({ key: "title" });
  allFields.push({ key: "slug" });
  if (isNonEnglish) allFields.push({ key: `tags${langSuffix}`, isTags: true });
  allFields.push({ key: "tags", isTags: true });
  if (isNonEnglish) allFields.push({ key: `metaDescription${langSuffix}` });
  allFields.push({ key: "metaDescription" });

  const anyGenerating = Object.values(generating).some(Boolean);

  const generateAll = async () => {
    for (const { key, isTags } of allFields) {
      await generate(key, isTags);
    }
  };

  return (
    <div className="metadata-tab">
      {isNonEnglish && (
        <MetaField
          label={`Title (${lang})`}
          value={fields[`title${langSuffix}`] ?? ""}
          onChange={(v) => updateField(`title${langSuffix}`, v)}
          onBlur={() => handleBlur(`title${langSuffix}`, fields[`title${langSuffix}`] ?? "")}
          onCopy={() => copyToClipboard(fields[`title${langSuffix}`] ?? "")}
          onGenerate={() => generate(`title${langSuffix}`)}
          generating={isGenerating(`title${langSuffix}`)}
        />
      )}
      <MetaField
        label="Title (en)"
        value={fields.title}
        onChange={(v) => updateField("title", v)}
        onBlur={() => handleBlur("title", fields.title)}
        onCopy={() => copyToClipboard(fields.title)}
        onGenerate={() => generate("title")}
        generating={isGenerating("title")}
      />
      <MetaField
        label="Slug"
        value={fields.slug}
        onChange={(v) => updateField("slug", v)}
        onBlur={() => handleBlur("slug", fields.slug)}
        onCopy={() => copyToClipboard(fields.slug)}
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

      {isNonEnglish && (
        <MetaField
          label={`Tags (${lang})`}
          value={fields[`tags${langSuffix}`] ?? ""}
          onChange={(v) => updateField(`tags${langSuffix}`, v)}
          onBlur={() => handleTagsBlur(`tags${langSuffix}`, fields[`tags${langSuffix}`] ?? "")}
          onCopy={() => copyToClipboard(fields[`tags${langSuffix}`] ?? "")}
          onGenerate={() => generate(`tags${langSuffix}`, true)}
          generating={isGenerating(`tags${langSuffix}`)}
          placeholder="tag1, tag2, tag3"
        />
      )}
      <MetaField
        label="Tags (en)"
        value={fields.tags}
        onChange={(v) => updateField("tags", v)}
        onBlur={() => handleTagsBlur("tags", fields.tags)}
        onCopy={() => copyToClipboard(fields.tags)}
        onGenerate={() => generate("tags", true)}
        generating={isGenerating("tags")}
        placeholder="tag1, tag2, tag3"
      />
      {isNonEnglish && (
        <MetaField
          label={`Description (${lang})`}
          value={fields[`metaDescription${langSuffix}`] ?? ""}
          onChange={(v) => updateField(`metaDescription${langSuffix}`, v)}
          onBlur={() => handleBlur(`metaDescription${langSuffix}`, fields[`metaDescription${langSuffix}`] ?? "")}
          onCopy={() => copyToClipboard(fields[`metaDescription${langSuffix}`] ?? "")}
          onGenerate={() => generate(`metaDescription${langSuffix}`)}
          generating={isGenerating(`metaDescription${langSuffix}`)}
          multiline
        />
      )}
      <MetaField
        label="Description (en)"
        value={fields.metaDescription}
        onChange={(v) => updateField("metaDescription", v)}
        onBlur={() => handleBlur("metaDescription", fields.metaDescription)}
        onCopy={() => copyToClipboard(fields.metaDescription)}
        onGenerate={() => generate("metaDescription")}
        generating={isGenerating("metaDescription")}
        multiline
      />
      <MetaField
        label="Extra"
        value={fields.extra}
        onChange={(v) => updateField("extra", v)}
        onBlur={() => handleBlur("extra", fields.extra)}
        onCopy={() => copyToClipboard(fields.extra)}
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
            Copy
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

function extractFields(
  fm: PostFrontMatter,
  lang: string
): Record<string, string> {
  const langSuffix = lang.charAt(0).toUpperCase() + lang.slice(1);
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

  if (lang !== "en") {
    fields[`title${langSuffix}`] = get(`title${langSuffix}`);
    fields[`tags${langSuffix}`] = get(`tags${langSuffix}`);
    fields[`metaDescription${langSuffix}`] = get(`metaDescription${langSuffix}`);
  }

  return fields;
}
