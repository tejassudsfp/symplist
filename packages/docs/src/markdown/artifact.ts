import type { Nodes, Root } from "mdast";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { safeDestination } from "./destinations.ts";
import { parseDocument, plainTextOf } from "./parse.ts";

export function escapeArtifactHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? "",
  );
}

const forbidden = new Set(["img", "picture", "source", "video", "audio", "iframe"]);
const processor = unified()
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSanitize, {
    ...defaultSchema,
    tagNames: defaultSchema.tagNames?.filter((tag) => !forbidden.has(tag)),
    protocols: { ...defaultSchema.protocols, href: ["https", "mailto"] },
    attributes: { ...defaultSchema.attributes, a: [...(defaultSchema.attributes?.a ?? []), "rel"] },
  })
  .use(rehypeStringify)
  .freeze();

/** Script-free, media-free standalone artifact HTML. Internal links become inert labels. */
export function renderArtifactMarkdown(source: string): string {
  const parsed = parseDocument(source);
  if (parsed.mode !== "parsed") return `<pre>${escapeArtifactHtml(source)}</pre>`;
  function clean(node: Nodes): Nodes {
    if (node.type === "html") return { type: "text", value: node.value };
    if (node.type === "image" || node.type === "link") {
      const destination = safeDestination(node.url);
      const label = node.type === "image" ? node.alt || "Image" : plainTextOf(node);
      if (!destination) return { type: "text", value: label };
      return {
        type: "link",
        url: destination.href,
        children: [{ type: "text", value: `${label} (${destination.display})` }],
        data: { hProperties: { rel: ["noopener", "noreferrer", "nofollow"] } },
      };
    }
    if ("children" in node) {
      node.children = node.children.map((child) => clean(child)) as typeof node.children;
    }
    return node;
  }
  const tree = clean(parsed.tree) as Root;
  // Explicitly remove reference definitions: unresolved private references cannot acquire hrefs.
  tree.children = tree.children.filter((node) => node.type !== "definition");
  return String(processor.stringify(processor.runSync(tree)));
}
