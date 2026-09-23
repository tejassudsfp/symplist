import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { describe, expect, it } from "vitest";
import { nextSlashQuery, type SlashQuery, slashPluginKey } from "./slash-plugin.ts";

/**
 * A miniature of the editor's schema: a paragraph, a code block and a heading is everything the open
 * and close rules distinguish between, and building it here keeps these tests free of Milkdown's
 * editor construction and of a DOM.
 */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
    heading: { group: "block", content: "text*", toDOM: () => ["h2", 0] },
    code_block: { group: "block", content: "text*", code: true, toDOM: () => ["pre", 0] },
    text: { inline: true },
  },
});

/** A document of one block holding `text`, with the caret at the end. */
function stateWith(text: string, node: "paragraph" | "heading" | "code_block" = "paragraph") {
  const type = schema.nodes[node];
  if (!type) throw new Error(`missing node ${node}`);
  const content = text.length > 0 ? [schema.text(text)] : [];
  const doc = schema.node("doc", null, [type.create(null, content)]);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + text.length)));
}

/**
 * Types `typed` at the caret and returns the query the plugin would hold afterwards, starting from
 * `previous`. This mirrors the real path exactly: a transaction that changed the document, then the
 * rules applied against the resulting state.
 */
function type(
  before: EditorState,
  typed: string,
  previous: SlashQuery | null = null,
): { query: SlashQuery | null; state: EditorState } {
  const transaction = before.tr.insertText(typed, before.selection.head);
  const state = before.apply(transaction);
  return { query: nextSlashQuery(previous, transaction, state), state };
}

describe("opening a slash query", () => {
  it("opens on a slash that starts an empty paragraph", () => {
    const { query } = type(stateWith(""), "/");
    expect(query).toMatchObject({ query: "" });
  });

  it("opens on a slash typed after a space", () => {
    const { query } = type(stateWith("write "), "/");
    expect(query).toMatchObject({ query: "" });
  });

  it("does not open mid-word, so a path or a fraction is just text", () => {
    expect(type(stateWith("and"), "/").query).toBeNull();
    expect(type(stateWith("https:/"), "/").query).toBeNull();
    expect(type(stateWith("1"), "/").query).toBeNull();
  });

  it("does not open inside a code block, where a slash is content", () => {
    expect(type(stateWith("", "code_block"), "/").query).toBeNull();
  });

  it("opens in a heading, which is still somewhere you structure a page", () => {
    expect(type(stateWith("", "heading"), "/").query).toMatchObject({ query: "" });
  });

  it("ignores a transaction that changed no text", () => {
    const state = stateWith("");
    expect(nextSlashQuery(null, state.tr, state)).toBeNull();
  });
});

describe("continuing a slash query", () => {
  it("collects what is typed after the slash", () => {
    const opened = type(stateWith(""), "/");
    const typed = type(opened.state, "head", opened.query);
    expect(typed.query).toMatchObject({ query: "head" });
  });

  it("keeps a name that contains a space", () => {
    const opened = type(stateWith(""), "/");
    const first = type(opened.state, "bulleted", opened.query);
    const second = type(first.state, " list", first.query);
    expect(second.query).toMatchObject({ query: "bulleted list" });
  });

  it("closes when the very next character is a space, which is prose", () => {
    const opened = type(stateWith(""), "/");
    expect(type(opened.state, " ", opened.query).query).toBeNull();
  });

  it("closes once the query grows past anything that could be a command", () => {
    const opened = type(stateWith(""), "/");
    expect(type(opened.state, "x".repeat(40), opened.query).query).toBeNull();
  });

  it("closes when the slash itself is deleted", () => {
    const opened = type(stateWith(""), "/");
    const query = opened.query as SlashQuery;
    const transaction = opened.state.tr.delete(query.from, query.from + 1);
    const state = opened.state.apply(transaction);
    expect(nextSlashQuery(query, transaction, state)).toBeNull();
  });

  it("closes when the caret moves back before the slash", () => {
    const opened = type(stateWith("write "), "/");
    const query = opened.query as SlashQuery;
    const transaction = opened.state.tr.setSelection(TextSelection.create(opened.state.doc, 1));
    const state = opened.state.apply(transaction);
    expect(nextSlashQuery(query, transaction, state)).toBeNull();
  });

  it("closes when a range is selected, because a menu belongs to a caret", () => {
    const opened = type(stateWith(""), "/");
    const first = type(opened.state, "head", opened.query);
    const transaction = first.state.tr.setSelection(TextSelection.create(first.state.doc, 1, 3));
    const state = first.state.apply(transaction);
    expect(nextSlashQuery(first.query, transaction, state)).toBeNull();
  });

  it("closes on an explicit request, whatever the document says", () => {
    const opened = type(stateWith(""), "/");
    const transaction = opened.state.tr.setMeta(slashPluginKey, null);
    const state = opened.state.apply(transaction);
    expect(nextSlashQuery(opened.query, transaction, state)).toBeNull();
  });
});
