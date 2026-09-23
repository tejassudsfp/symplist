"use client";

import {
  defaultValueCtx,
  Editor,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from "@milkdown/kit/core";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView as ProseView } from "@milkdown/kit/prose/view";
import { $prose, getMarkdown, replaceAll } from "@milkdown/kit/utils";
import {
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { ACTION_CONTEXT_ATTRIBUTE } from "@/actions/focus";
import { blockIndexOfSection, positionOfBlock } from "./blocks.ts";
import { type EditorHandle, matchesOf, wrapIndex } from "./editor.ts";
import { runToolbarCommand, type ToolbarCommand, toolbarCommandState } from "./page-commands.ts";
import type { ViewPosition } from "./sections.ts";
import {
  filterSlashCommands,
  moveSlashSelection,
  runSlashCommand,
  type SlashCommand,
} from "./slash-commands.ts";
import { SlashMenu, slashOptionId } from "./slash-menu.tsx";
import { closeSlashQuery, type SlashQuery, slashPlugin } from "./slash-plugin.ts";

/**
 * The page view (§9.3, research "Page editor"): Milkdown over the same Markdown string the raw view
 * edits. Its serializer is remark, so the canonical server serializer is a fixed point of its output
 * and a formatting-normalization commit is published once rather than on every save (decision R7).
 *
 * The page view is used only for documents it can represent faithfully: raw HTML and documents past
 * the parser work limits open read-only with a switch to the raw view, which the pane decides.
 */

export interface PageViewHandle extends EditorHandle {
  /** Runs a formatting command; false when it does not apply to the selection. */
  command(name: ToolbarCommand): boolean;
  /** Which formatting commands are active at the caret, for the toolbar's pressed state. */
  activeCommands(): readonly ToolbarCommand[];
  ready(): boolean;
}

export interface PageViewProps {
  readonly value: string;
  readonly onChange: (markdown: string) => void;
  /** Called when the caret moves, so the toolbar can report what is active. */
  readonly onSelectionChange?: () => void;
  readonly ref?: Ref<PageViewHandle>;
  readonly label?: string;
  /**
   * Runs the slash menu's one non-formatting entry. Simon is not a formatting command, so the editor
   * reports the request and the pane decides; when this is absent the entry is not offered at all
   * rather than offered and silently inert.
   */
  readonly onAskSimon?: () => void;
}

interface TextSpan {
  readonly start: number;
  readonly end: number;
  readonly pos: number;
}

/** The document's plain text with a map back to positions, so find can select what it matched. */
function textIndex(doc: ProseNode): { text: string; spans: TextSpan[] } {
  const spans: TextSpan[] = [];
  const parts: string[] = [];
  let length = 0;
  doc.forEach((block, offset) => {
    if (parts.length > 0) {
      parts.push("\n");
      length += 1;
    }
    block.descendants((node, pos) => {
      if (!node.isText || !node.text) return true;
      spans.push({ start: length, end: length + node.text.length, pos: offset + 1 + pos });
      parts.push(node.text);
      length += node.text.length;
      return true;
    });
  });
  return { text: parts.join(""), spans };
}

function docPosition(spans: readonly TextSpan[], offset: number): number | null {
  for (const span of spans) {
    if (offset >= span.start && offset <= span.end) return span.pos + (offset - span.start);
  }
  return null;
}

function startOfBlock(doc: ProseNode, blockIndex: number): number {
  const index = Math.max(0, Math.min(blockIndex, doc.childCount - 1));
  let position = 0;
  for (let child = 0; child < index; child += 1) position += doc.child(child).nodeSize;
  return position;
}

export function PageView({
  value,
  onChange,
  onSelectionChange,
  ref,
  label = "Document, editable",
  onAskSimon,
}: PageViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const applied = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSelectionRef = useRef(onSelectionChange);
  onSelectionRef.current = onSelectionChange;
  const initial = useRef(value);
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashAt, setSlashAt] = useState<{ left: number; top: number } | null>(null);
  const askSimonRef = useRef(onAskSimon);
  askSimonRef.current = onAskSimon;
  const listId = `${useId()}-slash`;

  const matches = slash
    ? filterSlashCommands(slash.query).filter(
        (command) => !command.external || askSimonRef.current !== undefined,
      )
    : [];
  // A narrower query can leave the highlight past the end of the list.
  const selected = matches.length === 0 ? 0 : Math.min(slashIndex, matches.length - 1);

  // The editor's key handler and the plugin both run outside React, so they read the current query,
  // list and highlight through refs rather than through a closure captured at mount.
  const slashRef = useRef<SlashQuery | null>(slash);
  slashRef.current = slash;
  const matchesRef = useRef<readonly SlashCommand[]>(matches);
  matchesRef.current = matches;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  /** Removes the "/query" text and then runs the command, so neither is left half-applied. */
  const choose = useCallback((command: SlashCommand) => {
    const editor = editorRef.current;
    const query = slashRef.current;
    if (!editor || !query) return;
    setSlash(null);
    setSlashIndex(0);
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const to = Math.min(view.state.selection.head, view.state.doc.content.size);
        view.dispatch(closeSlashQuery(view.state.tr.delete(query.from, to)));
        view.focus();
      });
      if (!runSlashCommand(editor, command.id)) askSimonRef.current?.();
    } catch {
      // A command can apply and still throw on its way out (scrolling needs layout jsdom lacks).
    }
  }, []);
  const chooseRef = useRef(choose);
  chooseRef.current = choose;

  // Where to draw the menu: just under the "/" itself. `coordsAtPos` is already viewport-relative
  // and the menu is fixed, so it needs no positioned ancestor and the editor's own layout — which
  // the document pane sizes and scrolls — is left exactly as it was.
  useEffect(() => {
    const editor = editorRef.current;
    if (!slash || !editor) {
      setSlashAt(null);
      return;
    }
    try {
      editor.action((ctx) => {
        const caret = ctx.get(editorViewCtx).coordsAtPos(slash.from);
        setSlashAt({ left: caret.left, top: caret.bottom + 4 });
      });
    } catch {
      // coordsAtPos needs layout; without it the menu simply does not draw this frame.
      setSlashAt(null);
    }
  }, [slash]);

  // Created once per mount: `value` is applied by the effect below, and a new editor would lose the
  // caret and the undo history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate one-time construction.
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let disposed = false;
    let created: Editor | null = null;
    const make = async () => {
      try {
        const editor = await Editor.make()
          .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, initial.current);
            ctx.update(editorViewOptionsCtx, (previous) => ({
              ...previous,
              attributes: { "aria-label": label, class: "sym-doc-page-content" },
              handleKeyDown: (view, event) => {
                const query = slashRef.current;
                if (!query) return false;
                const list = matchesRef.current;
                if (event.key === "Escape") {
                  view.dispatch(closeSlashQuery(view.state.tr));
                  return true;
                }
                if (list.length === 0) return false;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex(moveSlashSelection(selectedRef.current, delta, list.length));
                  return true;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  const command = list[selectedRef.current];
                  if (!command) return false;
                  chooseRef.current(command);
                  return true;
                }
                return false;
              },
            }));
            ctx.get(listenerCtx).markdownUpdated((_ctx, markdown, previous) => {
              if (markdown === previous) return;
              applied.current = markdown;
              onChangeRef.current(markdown);
            });
            ctx.get(listenerCtx).selectionUpdated(() => {
              onSelectionRef.current?.();
            });
          })
          .use(commonmark)
          .use(gfm)
          .use(history)
          .use(listener)
          .use($prose(() => slashPlugin(setSlash)))
          .create();
        created = editor;
        if (disposed) {
          void editor.destroy();
          return;
        }
        editorRef.current = editor;
        setReady(true);
      } catch {
        if (!disposed) setFailed(true);
      }
    };
    void make();
    return () => {
      disposed = true;
      setReady(false);
      const editor = created ?? editorRef.current;
      editorRef.current = null;
      if (editor) void editor.destroy();
    };
  }, []);

  // A revision published elsewhere (Simon, a restore, another device) replaces the document.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !ready) return;
    if (value === applied.current) return;
    applied.current = value;
    editor.action(replaceAll(value));
  }, [value, ready]);

  useImperativeHandle(ref, (): PageViewHandle => {
    const withView = <T,>(fallback: T, run: (view: ProseView, markdown: string) => T): T => {
      const editor = editorRef.current;
      if (!editor) return fallback;
      try {
        const markdown = editor.action(getMarkdown());
        return editor.action((ctx) => run(ctx.get(editorViewCtx), markdown)) as T;
      } catch {
        return fallback;
      }
    };
    return {
      ready: () => editorRef.current !== null,
      focus: () => {
        withView(undefined, (view) => view.focus());
      },
      position: () =>
        withView<ViewPosition>({ sectionIndex: 0, offsetInSection: 0 }, (view, markdown) => {
          const resolved = view.state.doc.resolve(view.state.selection.head);
          const blockIndex = resolved.depth > 0 ? resolved.index(0) : 0;
          return positionOfBlock(markdown, blockIndex);
        }),
      setPosition: (position, options) => {
        withView(undefined, (view, markdown) => {
          const blockIndex = blockIndexOfSection(markdown, position.sectionIndex);
          const at = startOfBlock(view.state.doc, blockIndex);
          const selection = TextSelection.near(
            view.state.doc.resolve(Math.min(at + 1, view.state.doc.content.size)),
          );
          view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
          if (options?.focus !== false) view.focus();
        });
      },
      showMatch: (query, index) =>
        withView(0, (view) => {
          const { text, spans } = textIndex(view.state.doc);
          const found = matchesOf(text, query);
          if (found.length === 0) return 0;
          const [from, to] = found[wrapIndex(index, found.length)] as [number, number];
          const start = docPosition(spans, from);
          const end = docPosition(spans, to);
          if (start === null || end === null) return found.length;
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, start, end))
              .scrollIntoView(),
          );
          return found.length;
        }),
      clearMatch: () => {
        withView(undefined, (view) => {
          const head = view.state.selection.head;
          view.dispatch(
            view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(head))),
          );
        });
      },
      command: (name) => {
        const editor = editorRef.current;
        if (!editor) return false;
        return runToolbarCommand(editor, name);
      },
      activeCommands: () => {
        const editor = editorRef.current;
        if (!editor) return [];
        return toolbarCommandState(editor);
      },
    };
  });

  if (failed) {
    return (
      <p className="sym-doc-notice" role="status">
        The page view couldn't start in this browser. Switch to Markdown to edit this page.
      </p>
    );
  }

  const activeOption = matches[selected];
  return (
    <>
      <div
        className="sym-doc-page"
        data-slot="page-view"
        data-ready={ready ? "true" : "false"}
        /* Drives the first paragraph's placeholder. Driven from the value rather than from a CSS
         * `:empty` test because an empty ProseMirror paragraph still contains a trailing break. */
        data-empty={value.trim().length === 0 ? "true" : "false"}
        {...(slash && matches.length > 0
          ? {
              "aria-owns": listId,
              "aria-activedescendant": activeOption
                ? slashOptionId(listId, activeOption.id)
                : undefined,
            }
          : {})}
        {...{ [ACTION_CONTEXT_ATTRIBUTE]: "editor" }}
        ref={host}
      />
      <SlashMenu
        commands={matches}
        selected={selected}
        onChoose={choose}
        position={slashAt}
        listId={listId}
      />
    </>
  );
}
