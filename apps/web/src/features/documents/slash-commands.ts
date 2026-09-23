"use client";

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import {
  createCodeBlockCommand,
  insertHrCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { insertTableCommand } from "@milkdown/kit/preset/gfm";
import { callCommand } from "@milkdown/kit/utils";

/**
 * The page view's slash menu (task_document.md: quiet editing controls, never a ribbon).
 *
 * The toolbar only appears once a page has content and only covers inline formatting, so starting a
 * structured page meant knowing Markdown or switching to the raw view. "/" is the gesture people
 * arrive with from every other editor, and it puts block structure a keystroke away without adding
 * permanent chrome to a calm surface.
 *
 * The catalog and the matching live here as data so their behaviour is testable without a DOM or an
 * editor instance; `slash-plugin.ts` owns only when a query is open, and `page-view.tsx` only draws
 * the list.
 */

export type SlashCommandId =
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "bullet_list"
  | "ordered_list"
  | "checklist"
  | "quote"
  | "code_block"
  | "divider"
  | "table"
  | "ask_simon";

export interface SlashCommand {
  readonly id: SlashCommandId;
  /** The name shown in the menu and matched against. */
  readonly label: string;
  /** One short line explaining the result, for people who do not recognise the name. */
  readonly hint: string;
  /** The compact glyph shown beside the label, matching the toolbar's plain style. */
  readonly glyph: string;
  readonly mono?: boolean;
  /**
   * Extra words that should find this command. A person looking for a checklist may well type
   * "todo", and failing to match that is the whole difference between a menu that helps and one
   * that makes you guess its vocabulary.
   */
  readonly keywords?: readonly string[];
  /**
   * Handled outside the editor: the menu reports it and the pane decides. Simon is not a formatting
   * command and must not be applied to the document behind the user's back.
   */
  readonly external?: true;
}

export const slashCommands: readonly SlashCommand[] = Object.freeze([
  {
    id: "heading_1",
    label: "Heading 1",
    hint: "Large section title",
    glyph: "H1",
    mono: true,
    keywords: ["title", "h1"],
  },
  {
    id: "heading_2",
    label: "Heading 2",
    hint: "Section title",
    glyph: "H2",
    mono: true,
    keywords: ["subtitle", "h2"],
  },
  {
    id: "heading_3",
    label: "Heading 3",
    hint: "Subsection title",
    glyph: "H3",
    mono: true,
    keywords: ["h3"],
  },
  {
    id: "bullet_list",
    label: "Bulleted list",
    hint: "A simple list",
    glyph: "•",
    keywords: ["bullet", "unordered", "ul"],
  },
  {
    id: "ordered_list",
    label: "Numbered list",
    hint: "A list with an order",
    glyph: "1.",
    mono: true,
    keywords: ["number", "ordered", "ol"],
  },
  {
    id: "checklist",
    label: "Checklist",
    hint: "Tick things off as you go",
    glyph: "☐",
    keywords: ["todo", "task", "check", "box"],
  },
  {
    id: "quote",
    label: "Quote",
    hint: "Set text apart",
    glyph: "❝",
    keywords: ["blockquote", "cite"],
  },
  {
    id: "code_block",
    label: "Code block",
    hint: "Preformatted code",
    glyph: "‹›",
    mono: true,
    keywords: ["snippet", "pre", "fence"],
  },
  {
    id: "divider",
    label: "Divider",
    hint: "A horizontal rule",
    glyph: "—",
    keywords: ["hr", "rule", "separator", "line"],
  },
  {
    id: "table",
    label: "Table",
    hint: "Rows and columns",
    glyph: "▦",
    keywords: ["grid", "rows", "columns"],
  },
  {
    id: "ask_simon",
    label: "Ask Simon for an outline",
    hint: "Draft a first structure for this task",
    glyph: "✦",
    keywords: ["outline", "draft", "ai", "simon", "structure"],
    external: true,
  },
]);

/** The longest query the menu will keep matching before it gives up and closes. */
export const MAX_SLASH_QUERY = 32;

function score(command: SlashCommand, query: string): number {
  if (query === "") return 1;
  const label = command.label.toLowerCase();
  // A prefix of the visible name is what the person almost always means, so it outranks everything.
  if (label.startsWith(query)) return 3;
  const words = label.split(/\s+/u);
  if (words.some((word) => word.startsWith(query))) return 2;
  if ((command.keywords ?? []).some((keyword) => keyword.startsWith(query))) return 2;
  if (label.includes(query)) return 1;
  return 0;
}

/**
 * The commands a query offers, best match first.
 *
 * Ties keep catalog order rather than sorting by name, so the list stays in a stable, deliberate
 * sequence — headings before lists before decoration — instead of rearranging as you type.
 */
export function filterSlashCommands(
  query: string,
  catalog: readonly SlashCommand[] = slashCommands,
): readonly SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle.length > MAX_SLASH_QUERY) return [];
  return catalog
    .map((command, index) => ({ command, index, rank: score(command, needle) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .map((entry) => entry.command);
}

/** Moves the highlighted index by `delta`, wrapping at both ends. */
export function moveSlashSelection(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

/**
 * Runs a slash command in the editor, having already removed the "/query" text.
 *
 * Returns false for a command the editor does not own — the pane handles those — so the caller can
 * tell "done" from "not mine" without inspecting the id.
 */
export function runSlashCommand(editor: Editor, id: SlashCommandId): boolean {
  switch (id) {
    case "heading_1":
      editor.action(callCommand(wrapInHeadingCommand.key, 1));
      return true;
    case "heading_2":
      editor.action(callCommand(wrapInHeadingCommand.key, 2));
      return true;
    case "heading_3":
      editor.action(callCommand(wrapInHeadingCommand.key, 3));
      return true;
    case "bullet_list":
      editor.action(callCommand(wrapInBulletListCommand.key));
      return true;
    case "ordered_list":
      editor.action(callCommand(wrapInOrderedListCommand.key));
      return true;
    case "checklist": {
      editor.action(callCommand(wrapInBulletListCommand.key));
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        const transaction = view.state.tr;
        let found = false;
        view.state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name !== "list_item") return true;
          found = true;
          transaction.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
          return true;
        });
        if (found) view.dispatch(transaction);
      });
      return true;
    }
    case "quote":
      editor.action(callCommand(wrapInBlockquoteCommand.key));
      return true;
    case "code_block":
      editor.action(callCommand(createCodeBlockCommand.key));
      return true;
    case "divider":
      editor.action(callCommand(insertHrCommand.key));
      return true;
    case "table":
      editor.action(callCommand(insertTableCommand.key));
      return true;
    case "ask_simon":
      return false;
  }
}
