import { useEffect, useState } from "react";
import type { PostFrontMatter, Target } from "../types";
import { updatePost } from "../api";

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

  // Local field state — synced from frontMatter on post change
  const [fields, setFields] = useState(() => extractFields(frontMatter, lang));

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
    if (value !== current) {
      saveField(key, value);
    }
  };

  const handleTagsBlur = (key: string, value: string) => {
    const tags = value
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const current = (frontMatter as Record<string, unknown>)[key];
    const currentStr = Array.isArray(current) ? current.join(", ") : "";
    if (value !== currentStr) {
      saveField(key, tags);
    }
  };

  const copyToClipboard = (value: string) => {
    navigator.clipboard.writeText(value).catch(() => {});
  };

  const updateField = (key: string, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  if (!requiresMetadata) {
    // Minimal: just slug
    return (
      <div className="metadata-tab">
        <MetaField
          label="Slug"
          value={fields.slug}
          onChange={(v) => updateField("slug", v)}
          onBlur={() => handleBlur("slug", fields.slug)}
          onCopy={() => copyToClipboard(fields.slug)}
        />
      </div>
    );
  }

  // Full metadata layout
  const langSuffix = lang.charAt(0).toUpperCase() + lang.slice(1);

  return (
    <div className="metadata-tab">
      {/* Title fields — above the divider */}
      {isNonEnglish && (
        <MetaField
          label={`Title (${lang})`}
          value={fields[`title${langSuffix}`] ?? ""}
          onChange={(v) => updateField(`title${langSuffix}`, v)}
          onBlur={() =>
            handleBlur(
              `title${langSuffix}`,
              fields[`title${langSuffix}`] ?? ""
            )
          }
          onCopy={() =>
            copyToClipboard(fields[`title${langSuffix}`] ?? "")
          }
        />
      )}
      <MetaField
        label="Title (en)"
        value={fields.title}
        onChange={(v) => updateField("title", v)}
        onBlur={() => handleBlur("title", fields.title)}
        onCopy={() => copyToClipboard(fields.title)}
      />
      <MetaField
        label="Slug"
        value={fields.slug}
        onChange={(v) => updateField("slug", v)}
        onBlur={() => handleBlur("slug", fields.slug)}
        onCopy={() => copyToClipboard(fields.slug)}
      />

      <div className="metadata-divider">
        <span>Generate All</span>
      </div>

      {/* Fields below the divider */}
      {isNonEnglish && (
        <MetaField
          label={`Tags (${lang})`}
          value={fields[`tags${langSuffix}`] ?? ""}
          onChange={(v) => updateField(`tags${langSuffix}`, v)}
          onBlur={() =>
            handleTagsBlur(
              `tags${langSuffix}`,
              fields[`tags${langSuffix}`] ?? ""
            )
          }
          onCopy={() =>
            copyToClipboard(fields[`tags${langSuffix}`] ?? "")
          }
          placeholder="tag1, tag2, tag3"
        />
      )}
      <MetaField
        label="Tags (en)"
        value={fields.tags}
        onChange={(v) => updateField("tags", v)}
        onBlur={() => handleTagsBlur("tags", fields.tags)}
        onCopy={() => copyToClipboard(fields.tags)}
        placeholder="tag1, tag2, tag3"
      />
      {isNonEnglish && (
        <MetaField
          label={`Description (${lang})`}
          value={fields[`metaDescription${langSuffix}`] ?? ""}
          onChange={(v) => updateField(`metaDescription${langSuffix}`, v)}
          onBlur={() =>
            handleBlur(
              `metaDescription${langSuffix}`,
              fields[`metaDescription${langSuffix}`] ?? ""
            )
          }
          onCopy={() =>
            copyToClipboard(
              fields[`metaDescription${langSuffix}`] ?? ""
            )
          }
          multiline
        />
      )}
      <MetaField
        label="Description (en)"
        value={fields.metaDescription}
        onChange={(v) => updateField("metaDescription", v)}
        onBlur={() => handleBlur("metaDescription", fields.metaDescription)}
        onCopy={() => copyToClipboard(fields.metaDescription)}
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
  multiline,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  onCopy: () => void;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="meta-field">
      <div className="meta-field-header">
        <label className="meta-field-label">{label}</label>
        <button
          className="meta-field-copy"
          onClick={onCopy}
          title="Copy to clipboard"
        >
          Copy
        </button>
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
    fields[`metaDescription${langSuffix}`] = get(
      `metaDescription${langSuffix}`
    );
  }

  return fields;
}
