import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import type { ContentFont } from "@shared/types";
import { editorHighlighting } from "./editorHighlight";
import { useI18n, type Translator } from "../i18n/I18nContext";

// CodeMirror's basicSetup without folding: a post is short enough that
// collapsing a section under its heading rarely helps, and the fold gutter put
// a typed mark beside every heading. Everything else basicSetup provides stays.
const editorSetup = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...completionKeymap,
    ...lintKeymap,
  ]),
];

// CodeMirror's own words (the search and go-to-line panels, screen-reader
// announcements), in the interface language. CodeMirror fills "$" itself.
export function editorPhrases({ t }: Translator): Record<string, string> {
  return {
    Find: t("editor.find"),
    Replace: t("editor.replace"),
    next: t("editor.next"),
    previous: t("editor.previous"),
    all: t("editor.all"),
    "match case": t("editor.matchCase"),
    "by word": t("editor.byWord"),
    regexp: t("editor.regexp"),
    replace: t("editor.replaceOne"),
    "replace all": t("editor.replaceAll"),
    close: t("common.close"),
    "current match": t("editor.currentMatch"),
    "on line": t("editor.onLine"),
    "replaced $ matches": t("editor.replacedMatches", { count: "$" }),
    "replaced match on line $": t("editor.replacedMatchOnLine", { line: "$" }),
    "Go to line": t("editor.goToLine"),
    go: t("editor.go"),
    "Selection deleted": t("editor.selectionDeleted"),
    "Control character": t("editor.controlCharacter"),
    Completions: t("editor.completions"),
    Diagnostics: t("editor.diagnostics"),
    "No diagnostics": t("editor.noDiagnostics"),
  };
}

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
  const phrasesCompartmentRef = useRef(new Compartment());
  const translator = useI18n();
  const translatorRef = useRef(translator);
  translatorRef.current = translator;
  const appliedTranslatorRef = useRef(translator);
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
        editorSetup,
        markdown({ codeLanguages: languages }),
        // Theme-token syntax colors; displaces the setup's fixed-color fallback.
        editorHighlighting,
        placeholder(watermark),
        updateListener,
        readOnlyCompartmentRef.current.of(EditorState.readOnly.of(readOnly)),
        editableCompartmentRef.current.of(EditorView.editable.of(!readOnly)),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: "true" }),
        themeCompartmentRef.current.of(buildEditorTheme(contentFontRef.current)),
        phrasesCompartmentRef.current.of(EditorState.phrases.of(editorPhrases(translatorRef.current))),
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

  // Follow a language change without rebuilding the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || appliedTranslatorRef.current === translator) return;
    appliedTranslatorRef.current = translator;
    view.dispatch({
      effects: phrasesCompartmentRef.current.reconfigure(EditorState.phrases.of(editorPhrases(translator))),
    });
  }, [translator]);

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
