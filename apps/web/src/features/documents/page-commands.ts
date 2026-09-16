"use client";

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import {
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
} from "@milkdown/kit/preset/commonmark";
import type { EditorView as ProseView } from "@milkdown/kit/prose/view";
import { callCommand } from "@milkdown/kit/utils";

/**
 * The page view's small contextual formatting toolbar (task_document.md: "a small contextual
 * formatting toolbar or quiet editing controls", never a ribbon). Checklists are a GFM list item
 * with a `checked` attribute, so the checklist control wraps in a bullet list first and then toggles
 * the attribute on every item in the selection.
 */

export type ToolbarCommand =
  | "bold"
  | "italic"
  | "heading"
  | "bullet_list"
  | "checklist"
  | "code"
  | "quote";

export interface ToolbarButton {
  readonly id: ToolbarCommand;
  /** Accessible name and tooltip. */
  readonly label: string;
  /** The compact glyph from the sample's toolbar. */
  readonly glyph: string;
  readonly mono?: boolean;
  readonly weight?: number;
  readonly italic?: boolean;
}

/** The sample's toolbar, in order. */
export const toolbarButtons: readonly ToolbarButton[] = [
  { id: "bold", label: "Bold", glyph: "B", weight: 700 },
  { id: "italic", label: "Italic", glyph: "I", italic: true },
  { id: "heading", label: "Heading", glyph: "H2", weight: 600, mono: true },
  { id: "bullet_list", label: "Bulleted list", glyph: "•" },
  { id: "checklist", label: "Checklist", glyph: "☐" },
  { id: "code", label: "Code", glyph: "‹›", mono: true },
  { id: "quote", label: "Quote", glyph: "❝" },
];

/** The heading level the toolbar's single heading control applies (the sample shows H2). */
export const TOOLBAR_HEADING_LEVEL = 2;

function viewOf(editor: Editor): ProseView | null {
  try {
    return editor.action((ctx) => ctx.get(editorViewCtx));
  } catch {
    return null;
  }
}

interface ListItem {
  readonly pos: number;
  readonly checked: unknown;
  readonly attrs: Record<string, unknown>;
}

function listItemsInSelection(view: ProseView): ListItem[] {
  const { from, to } = view.state.selection;
  const items: ListItem[] = [];
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "list_item") {
      items.push({ pos, checked: node.attrs.checked, attrs: { ...node.attrs } });
    }
    return true;
  });
  return items;
}

function toggleChecklist(view: ProseView): boolean {
  const items = listItemsInSelection(view);
  if (items.length === 0) return false;
  const allTasks = items.every((item) => item.checked !== null && item.checked !== undefined);
  const transaction = view.state.tr;
  for (const item of items) {
    transaction.setNodeMarkup(item.pos, undefined, {
      ...item.attrs,
      checked: allTasks ? null : false,
    });
  }
  view.dispatch(transaction);
  return true;
}

/** Runs one toolbar command. Returns false when it does not apply where the caret is. */
export function runToolbarCommand(editor: Editor, name: ToolbarCommand): boolean {
  try {
    switch (name) {
      case "bold":
        return editor.action(callCommand(toggleStrongCommand.key));
      case "italic":
        return editor.action(callCommand(toggleEmphasisCommand.key));
      case "code":
        return editor.action(callCommand(toggleInlineCodeCommand.key));
      case "heading":
        return editor.action(
          callCommand(
            wrapInHeadingCommand.key,
            activeCommands(editor).includes("heading") ? 0 : TOOLBAR_HEADING_LEVEL,
          ),
        );
      case "bullet_list":
        return editor.action(callCommand(wrapInBulletListCommand.key));
      case "quote":
        return editor.action(callCommand(wrapInBlockquoteCommand.key));
      case "checklist": {
        const view = viewOf(editor);
        if (!view) return false;
        if (listItemsInSelection(view).length === 0) {
          editor.action(callCommand(wrapInBulletListCommand.key));
        }
        const after = viewOf(editor);
        return after ? toggleChecklist(after) : false;
      }
    }
  } catch {
    return false;
  }
}

function activeCommands(editor: Editor): ToolbarCommand[] {
  const view = viewOf(editor);
  if (!view) return [];
  const { state } = view;
  const { from, $from, to, empty } = state.selection;
  const active: ToolbarCommand[] = [];
  const markActive = (name: string): boolean => {
    const type = state.schema.marks[name];
    if (!type) return false;
    return empty
      ? Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
      : state.doc.rangeHasMark(from, to, type);
  };
  if (markActive("strong")) active.push("bold");
  if (markActive("emphasis")) active.push("italic");
  if (markActive("inlineCode")) active.push("code");
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    if (name === "heading" && !active.includes("heading")) active.push("heading");
    if (name === "bullet_list" && !active.includes("bullet_list")) active.push("bullet_list");
    if (name === "blockquote" && !active.includes("quote")) active.push("quote");
    if (
      name === "list_item" &&
      $from.node(depth).attrs.checked !== null &&
      $from.node(depth).attrs.checked !== undefined &&
      !active.includes("checklist")
    ) {
      active.push("checklist");
    }
  }
  return active;
}

/** Which toolbar controls are active at the caret, for their pressed state. */
export function toolbarCommandState(editor: Editor): readonly ToolbarCommand[] {
  try {
    return activeCommands(editor);
  } catch {
    return [];
  }
}
