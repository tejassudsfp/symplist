"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { ACTION_CONTEXT_ATTRIBUTE } from "@/actions/focus";
import { type EditorHandle, matchesOf, wrapIndex } from "./editor.ts";
import { offsetOfPosition, positionOfOffset, type ViewPosition } from "./sections.ts";

/**
 * The raw Markdown view (§9.3, research "Page editor"): CodeMirror 6 over the Markdown string, which
 * is lossless. It is the fallback whenever the page view cannot represent a document faithfully —
 * raw HTML, or a document past the parser work limits — and the discoverable "Markdown" view the
 * task_document brief asks for.
 */

export interface RawViewProps {
  readonly value: string;
  readonly onChange: (markdown: string) => void;
  readonly readOnly?: boolean;
  readonly ref?: Ref<EditorHandle>;
  /** Accessible name of the editing surface. */
  readonly label?: string;
}

export function RawView({
  value,
  onChange,
  readOnly = false,
  ref,
  label = "Markdown source",
}: RawViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The editor is created once per mount; `value`, `label` and `readOnly` are applied by the effects
  // below. Re-creating the view would lose focus, the undo history and the selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate one-time construction.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const editor = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          EditorView.lineWrapping,
          editable.current.of(EditorView.editable.of(!readOnly)),
          EditorView.contentAttributes.of({
            "aria-label": label,
            role: "textbox",
            "aria-multiline": "true",
            spellcheck: "true",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      if (view.current === editor) view.current = null;
    };
  }, []);

  // Server-published text (a Simon edit, a restore) replaces the document without dropping the
  // caret: CodeMirror maps the selection through the change.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: editable.current.reconfigure(EditorView.editable.of(!readOnly)),
    });
  }, [readOnly]);

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      focus: () => view.current?.focus(),
      position: () => {
        const editor = view.current;
        if (!editor) return { sectionIndex: 0, offsetInSection: 0 };
        return positionOfOffset(editor.state.doc.toString(), editor.state.selection.main.head);
      },
      setPosition: (position: ViewPosition, options) => {
        const editor = view.current;
        if (!editor) return;
        const text = editor.state.doc.toString();
        const offset = Math.min(offsetOfPosition(text, position), editor.state.doc.length);
        editor.dispatch({
          selection: { anchor: offset },
          scrollIntoView: true,
        });
        if (options?.focus !== false) editor.focus();
      },
      showMatch: (query, index) => {
        const editor = view.current;
        if (!editor) return 0;
        const found = matchesOf(editor.state.doc.toString(), query);
        if (found.length === 0) return 0;
        const [from, to] = found[wrapIndex(index, found.length)] as [number, number];
        editor.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
        return found.length;
      },
      clearMatch: () => {
        const editor = view.current;
        if (!editor) return;
        const head = editor.state.selection.main.head;
        editor.dispatch({ selection: { anchor: head } });
      },
    }),
  );

  return (
    <div
      className="sym-doc-raw"
      data-slot="raw-view"
      {...{ [ACTION_CONTEXT_ATTRIBUTE]: "editor" }}
      ref={host}
    />
  );
}
