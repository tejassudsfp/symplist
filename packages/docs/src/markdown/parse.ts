import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { type DocumentComplexityReason, documentComplexity } from "./limits.ts";

const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/**
 * Parses Markdown with GFM into mdast with position offsets (UTF-16 indices). Callers must apply the
 * work limits first ({@link parseDocument} does); this throws on parser failures such as a stack
 * overflow.
 */
export function parseMarkdownTree(source: string): Root {
  return parser.parse(source);
}

export type DocumentParse =
  | { readonly mode: "parsed"; readonly tree: Root }
  | {
      readonly mode: "fallback";
      /** Why the parser was not used: a work limit, or `parser_failed`. */
      readonly reason: DocumentComplexityReason | "parser_failed";
    };

/**
 * Parses a task document when it is within the document work limits; otherwise (or when the parser
 * fails) reports `fallback`, and callers index it with the line scanner. Never throws for any string.
 */
export function parseDocument(source: string): DocumentParse {
  const complexity = documentComplexity(source);
  if (!complexity.parseable) {
    return { mode: "fallback", reason: complexity.reason ?? "length" };
  }
  try {
    return { mode: "parsed", tree: parseMarkdownTree(source) };
  } catch {
    return { mode: "fallback", reason: "parser_failed" };
  }
}

/** The plain text of a node (text, inline code and code values, image alt text), iteratively. */
export function plainTextOf(node: Nodes): string {
  const parts: string[] = [];
  const stack: Nodes[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as Nodes;
    if ("value" in current && typeof current.value === "string" && current.type !== "html") {
      parts.push(current.value);
    }
    if ("alt" in current && typeof current.alt === "string") parts.push(current.alt);
    if ("children" in current) {
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        stack.push(current.children[index] as Nodes);
      }
    }
  }
  return parts.join("");
}

/** Whether any node of the tree is raw HTML (mdast `html`), which opens the page view read-only (§9.3). */
export function containsRawHtml(tree: Root): boolean {
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop() as Nodes;
    if (node.type === "html") return true;
    if ("children" in node) for (const child of node.children) stack.push(child as Nodes);
  }
  return false;
}
