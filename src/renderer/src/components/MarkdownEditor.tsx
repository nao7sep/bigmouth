import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { basicSetup } from "codemirror";
import type { ContentFont } from "@shared/types";

export interface MarkdownEditorHandle {
  insertAtCursor: (text: string) => void;
}

interface MarkdownEditorProps {
  initialContent: string;
  onContentChange: (value: string) => void;
  watermark: string;
  contentFont: ContentFont;
  readOnly?: boolean;
}

// The editor's content font, built from settings. A blank family inherits the UI
// font (--bm-font-ui via the document body); size/line-height/padding/weight/
// style/decoration come straight from the content-font settings.
export function buildEditorTheme(font: ContentFont) {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: `${font.size}px`,
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: font.family.trim() || "inherit",
      lineHeight: String(font.lineHeight),
    },
    ".cm-content": {
      padding: `${font.padding}px`,
      fontWeight: font.bold ? "bold" : "normal",
      fontStyle: font.italic ? "italic" : "normal",
      textDecoration: font.underline ? "underline" : "none",
    },
    "&.cm-focused": {
      outline: "none",
    },
  });
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    { initialContent, onContentChange, watermark, contentFont, readOnly = false }: MarkdownEditorProps,
    ref
  ) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onContentChange);
  const readOnlyCompartmentRef = useRef(new Compartment());
  const editableCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  const appliedReadOnlyRef = useRef(readOnly);
  const appliedContentFontRef = useRef(contentFont);
  // Read the latest content font without retriggering the create-once effect.
  const contentFontRef = useRef(contentFont);
  contentFontRef.current = contentFont;

  useImperativeHandle(ref, () => ({
    insertAtCursor(text: string) {
      const view = viewRef.current;
      if (!view) return;
      if (readOnly) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
      view.focus();
    },
  }));

  // Keep callback ref current
  onChangeRef.current = onContentChange;

  // Create editor once
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChangeRef.current(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        basicSetup,
        markdown({ codeLanguages: languages }),
        placeholder(watermark),
        updateListener,
        readOnlyCompartmentRef.current.of(EditorState.readOnly.of(readOnly)),
        editableCompartmentRef.current.of(EditorView.editable.of(!readOnly)),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: "true" }),
        themeCompartmentRef.current.of(buildEditorTheme(contentFontRef.current)),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // A keyed CenterPane mounts one editor per post. Keeping the document
    // editor-owned after this seed is important: feeding each intermediate
    // React render back into CodeMirror can replace its composition DOM while
    // a macOS IME candidate is active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedReadOnlyRef.current === readOnly) return;
    appliedReadOnlyRef.current = readOnly;
    view.dispatch({
      effects: [
        readOnlyCompartmentRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
        editableCompartmentRef.current.reconfigure(EditorView.editable.of(!readOnly)),
      ],
    });
  }, [readOnly]);

  // Re-theme live when the content font changes, so a Settings save takes effect
  // without rebuilding the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedContentFontRef.current === contentFont) return;
    appliedContentFontRef.current = contentFont;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(buildEditorTheme(contentFont)),
    });
  }, [contentFont]);

  return <div ref={containerRef} className="cm-container" />;
});
