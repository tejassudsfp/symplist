import { parseDocument, serializeCanonicalTree } from "@symplist/docs/markdown";

/** Strip private app/object capabilities, not arbitrary text. The UI never promises secret detection. */
export function exportMarkdown(source: string, privateOrigins: readonly string[] = []): string {
  const sanitized = source
    .replace(/\b(?:sym_[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g, "[credential removed]")
    .replace(/\bBearer\s+[A-Za-z0-9_.~+/-]{12,}/gi, "Bearer [credential removed]")
    .replace(
      /https?:\/\/[^\s<>)]*[?&](?:key|token|access_token|X-Amz-Signature)=[^\s<>)]*/gi,
      "[private link removed]",
    )
    .replace(
      /https?:\/\/[^\s<>)]*\/u\/[^/\s]+\/(?:docs|bundles|jobs|artifacts)\/[^\s<>)]*/gi,
      "[private object removed]",
    )
    .replace(
      /https?:\/\/[^/\s]+\.r2(?:\.cloudflarestorage)?\.com\/[^\s<>)]*/gi,
      "[private object removed]",
    );
  const parsed = parseDocument(sanitized);
  if (parsed.mode !== "parsed")
    return sanitized.replace(/!?\[([^\]]*)\]\((?:\/|symplist:)[^)]*\)/g, "$1");
  // Internal links are labels even in raw Markdown. Never export app navigation or R2 object paths.
  const privateDestination = (value: string) => {
    try {
      return privateOrigins.includes(new URL(value).origin);
    } catch {
      return false;
    }
  };
  const walk = (node: { type: string; url?: string; value?: string; children?: unknown[] }) => {
    if (
      (node.type === "link" || node.type === "image" || node.type === "definition") &&
      node.url &&
      (!/^(https:\/\/|mailto:)/i.test(node.url) ||
        privateDestination(node.url) ||
        /\/u\/[^/]+\/(?:docs|bundles|jobs|artifacts)\//.test(node.url) ||
        /\.r2(?:\.cloudflarestorage)?\.com(?:[/:]|$)/i.test(node.url))
    ) {
      node.url = "";
    }
    for (const child of node.children ?? []) walk(child as Parameters<typeof walk>[0]);
  };
  walk(parsed.tree);
  return serializeCanonicalTree(parsed.tree);
}

/** Saved prompts retain references, never capability URLs. Trusted UI assembles live URLs in memory. */
export function handoffTemplate(
  prompt: string,
  artifactIds: readonly string[],
  privateOrigins: readonly string[] = [],
): string {
  return `${exportMarkdown(prompt, privateOrigins)}\n\n## Supplied artifacts\n${artifactIds.map((id, index) => `${index + 1}. {{artifact:${id}}}`).join("\n")}\n\n## Returning the result\nReturn your result to the owner to review and paste into Symplist. A shared link is read-only; it does not authorize editing or connector access. If a link expires or cannot be fetched, ask for a fresh link or a pasted/downloaded copy.\n`;
}
