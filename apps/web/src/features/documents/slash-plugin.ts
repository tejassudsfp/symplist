"use client";

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@milkdown/kit/prose/state";

/**
 * Tracks whether a slash query is open and what has been typed after the "/".
 *
 * This is a plain ProseMirror plugin rather than Milkdown's slash factory because the factory hands
 * positioning and rendering to its own tooltip provider; we already own a themed menu and need the
 * query state in React to drive it. Keeping only the state here means the rules below are the whole
 * behaviour, and `slash-state.ts` can test them against a document without a browser.
 */

export interface SlashQuery {
  /** Position of the "/" itself. */
  readonly from: number;
  /** Position just after the last typed character. */
  readonly to: number;
  /** What was typed after the "/", excluding it. */
  readonly query: string;
}

export const slashPluginKey = new PluginKey<SlashQuery | null>("symplist-slash");

/** How far after the "/" a query may run before it is certainly prose, not a command. */
const MAX_QUERY = 32;

/**
 * Whether a "/" at `pos` opens a menu.
 *
 * Only at the very start of a text block, or directly after whitespace. Typing a URL, a fraction or
 * a path mid-sentence must never pop a menu — that is the failure that makes slash menus in other
 * products feel like they are fighting you.
 */
function opensMenu(state: EditorState, pos: number): boolean {
  const resolved = state.doc.resolve(pos);
  if (!resolved.parent.isTextblock) return false;
  // Code blocks are literal text; "/" there is content.
  if (resolved.parent.type.spec.code) return false;
  const offset = pos - resolved.start();
  if (offset === 0) return true;
  const before = resolved.parent.textBetween(Math.max(0, offset - 1), offset, undefined, "￼");
  return /\s|￼/u.test(before);
}

/** The text between two positions in the same text block, or null when that is not what they are. */
function textBetween(doc: ProseNode, from: number, to: number): string | null {
  if (to < from) return null;
  const resolvedFrom = doc.resolve(from);
  const resolvedTo = doc.resolve(to);
  if (resolvedFrom.parent !== resolvedTo.parent) return null;
  return resolvedFrom.parent.textBetween(
    from - resolvedFrom.start(),
    to - resolvedTo.start(),
    undefined,
    "￼",
  );
}

/**
 * The query after a transaction, given the query before it.
 *
 * Exported for its tests: every rule that closes a menu is here, and each one is a bug people hit
 * when it is missing — a menu that survives a click elsewhere, or one that stays open over text that
 * stopped being a command three words ago.
 */
export function nextSlashQuery(
  previous: SlashQuery | null,
  transaction: Transaction,
  state: EditorState,
): SlashQuery | null {
  const meta = transaction.getMeta(slashPluginKey);
  if (meta === null) return null;

  const selection = state.selection;
  // A menu belongs to a caret. Any selection with a range is a different gesture.
  if (!selection.empty) return null;

  if (previous) {
    const from = transaction.mapping.map(previous.from, -1);
    const head = selection.head;
    if (head < from + 1) return null;
    const slash = textBetween(state.doc, from, from + 1);
    if (slash !== "/") return null;
    const query = textBetween(state.doc, from + 1, head);
    if (query === null || query.length > MAX_QUERY) return null;
    // A space only ends the query when nothing has been typed yet: "/ " is prose, while
    // "/bulleted list" is still someone typing a name with a space in it.
    if (query.startsWith(" ")) return null;
    if (/[\n￼]/u.test(query)) return null;
    return { from, to: head, query };
  }

  if (!transaction.docChanged) return null;
  const head = selection.head;
  const typed = textBetween(state.doc, head - 1, head);
  if (typed !== "/") return null;
  if (!opensMenu(state, head - 1)) return null;
  return { from: head - 1, to: head, query: "" };
}

/**
 * The plugin. `onChange` is how React hears about the query without polling the editor.
 */
export function slashPlugin(onChange: (query: SlashQuery | null) => void): Plugin {
  return new Plugin<SlashQuery | null>({
    key: slashPluginKey,
    state: {
      init: () => null,
      apply(transaction, value, _old, state) {
        const next = nextSlashQuery(value, transaction, state);
        if (next?.from !== value?.from || next?.query !== value?.query) {
          // Notifying during apply would set React state while ProseMirror is mid-update.
          queueMicrotask(() => onChange(next));
        }
        return next;
      },
    },
    props: {
      handleDOMEvents: {
        blur: (view) => {
          if (slashPluginKey.getState(view.state)) {
            view.dispatch(view.state.tr.setMeta(slashPluginKey, null));
          }
          return false;
        },
      },
    },
  });
}

/** Closes an open menu without changing the document. */
export function closeSlashQuery(transaction: Transaction): Transaction {
  return transaction.setMeta(slashPluginKey, null);
}
