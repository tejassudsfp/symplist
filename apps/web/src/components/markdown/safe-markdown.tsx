import type { Definition, Nodes, Parent, Root, RootContent, TableCell, TableRow } from "mdast";
import { Fragment, type ReactNode, useMemo } from "react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { cn } from "@/lib/utils";

/** Longest source rendered as Markdown; anything longer is shown as plain text. */
export const MAX_MARKDOWN_LENGTH = 50_000;
/** Deeper nesting (hostile blockquote or list towers) is flattened to text. */
export const MAX_MARKDOWN_DEPTH = 24;
/**
 * Parser work limits. The Markdown parser is superlinear (and recursive) on some inputs: thousands
 * of emphasis delimiters, deeply nested brackets, or towers of container markers take seconds to
 * minutes or overflow the stack well under the length limit. Sources beyond these limits render as
 * plain text, which keeps every character visible without parsing it.
 */
export const MAX_MARKDOWN_EMPHASIS_DELIMITERS = 2_000;
export const MAX_MARKDOWN_BACKTICKS = 2_000;
export const MAX_MARKDOWN_BRACKETS = 2_000;
export const MAX_MARKDOWN_BRACKET_DEPTH = 32;
export const MAX_MARKDOWN_LINE_CONTAINERS = 16;
export const MAX_MARKDOWN_CONTAINER_MARKERS = 4_000;
export const MAX_MARKDOWN_INDENT_COLUMNS = 96;

const processor = unified().use(remarkParse).use(remarkGfm).freeze();

const listMarkerPattern = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$)/;

/**
 * A linear pre-scan that decides whether a source is cheap enough to parse: emphasis and
 * strikethrough delimiters, backticks, brackets and their open depth within a paragraph, container markers
 * (`>` and list markers) per line and in total, and leading indentation. Code blocks are counted too:
 * whether a line is code depends on the surrounding containers and HTML blocks, so skipping
 * "probable" code would let crafted input past the limits.
 */
export function isMarkdownTooComplex(source: string): boolean {
  if (source.length > MAX_MARKDOWN_LENGTH) return true;
  let delimiters = 0;
  let backticks = 0;
  let brackets = 0;
  let bracketDepth = 0;
  let containerMarkers = 0;
  for (const line of source.split("\n")) {
    let index = 0;
    let columns = 0;
    let containers = 0;
    while (index < line.length) {
      const character = line[index];
      if (character === " ") {
        columns += 1;
        index += 1;
      } else if (character === "\t") {
        columns += 4 - (columns % 4);
        index += 1;
      } else if (character === ">") {
        containers += 1;
        index += 1;
      } else {
        const marker = listMarkerPattern.exec(line.slice(index, index + 11));
        if (!marker) break;
        containers += 1;
        index += marker[0].length;
      }
    }
    containerMarkers += containers;
    if (
      columns > MAX_MARKDOWN_INDENT_COLUMNS ||
      containers > MAX_MARKDOWN_LINE_CONTAINERS ||
      containerMarkers > MAX_MARKDOWN_CONTAINER_MARKERS
    ) {
      return true;
    }
    // Links never span a blank line, so bracket depth is tracked per paragraph.
    if (index >= line.length) bracketDepth = 0;
    for (; index < line.length; index += 1) {
      const character = line[index];
      if (character === "\\") {
        index += 1;
      } else if (character === "*" || character === "_" || character === "~") {
        delimiters += 1;
      } else if (character === "`") {
        backticks += 1;
      } else if (character === "[") {
        brackets += 1;
        bracketDepth += 1;
        if (bracketDepth > MAX_MARKDOWN_BRACKET_DEPTH || brackets > MAX_MARKDOWN_BRACKETS) {
          return true;
        }
      } else if (character === "]" && bracketDepth > 0) {
        bracketDepth -= 1;
      }
    }
    if (delimiters > MAX_MARKDOWN_EMPHASIS_DELIMITERS || backticks > MAX_MARKDOWN_BACKTICKS) {
      return true;
    }
  }
  return false;
}

export interface SafeDestination {
  readonly href: string;
  /** What the reader sees before following the link: a host, or an email address. */
  readonly display: string;
  readonly kind: "https" | "mailto";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Allows only absolute `https:` URLs without credentials and `mailto:` addresses (§10.4). Relative,
 * protocol-relative, `http:`, `javascript:`, `data:` and every other scheme are refused.
 */
export function safeDestination(raw: string | null | undefined): SafeDestination | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048 || controlCharacters.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") {
    if (url.username || url.password || !url.hostname) return null;
    return { href: url.href, display: url.hostname, kind: "https" };
  }
  if (url.protocol === "mailto:") {
    let address: string;
    try {
      address = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (!/^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+$/.test(address)) return null;
    return { href: url.href, display: address, kind: "mailto" };
  }
  return null;
}

function plainText(node: Nodes): string {
  const parts: string[] = [];
  const stack: Nodes[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as Nodes;
    if ("value" in current && typeof current.value === "string") parts.push(current.value);
    if ("alt" in current && typeof current.alt === "string") parts.push(current.alt);
    if ("children" in current) {
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        stack.push(current.children[index] as Nodes);
      }
    }
  }
  return parts.join("");
}

interface RenderContext {
  readonly definitions: ReadonlyMap<string, Definition>;
  readonly headingLevelStart: number;
  readonly insideLink: boolean;
}

function collectDefinitions(root: Root): Map<string, Definition> {
  const definitions = new Map<string, Definition>();
  const stack: Nodes[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Nodes;
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
    if ("children" in node) stack.push(...(node.children as Nodes[]));
  }
  return definitions;
}

function ExternalLink({
  destination,
  children,
}: {
  destination: SafeDestination;
  children: ReactNode;
}) {
  return (
    <a
      className="sym-md-link"
      href={destination.href}
      rel="noopener noreferrer"
      target="_blank"
      data-destination={destination.kind}
    >
      {children}
      <span className="sym-md-link-host"> ({destination.display})</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function renderImage(
  alt: string | null | undefined,
  url: string,
  key: string,
  context: RenderContext,
): ReactNode {
  const label = `Image: ${alt?.trim() || "untitled"}`;
  const destination = safeDestination(url);
  // Remote images are never fetched: they become a labeled link (or inert text) instead of <img>.
  if (destination?.kind !== "https" || context.insideLink) {
    return (
      <span key={key} className="sym-md-image-label">
        {label}
        {destination?.kind === "https" ? ` (${destination.display})` : ""}
      </span>
    );
  }
  return (
    <ExternalLink key={key} destination={destination}>
      <span className="sym-md-image-label">{label}</span>
    </ExternalLink>
  );
}

function renderChildren(parent: Parent, context: RenderContext, depth: number, prefix: string) {
  return parent.children.map((child, index) =>
    renderNode(child as RootContent, context, depth + 1, `${prefix}.${index}`),
  );
}

function renderLink(
  url: string,
  node: Parent,
  context: RenderContext,
  depth: number,
  key: string,
): ReactNode {
  const destination = safeDestination(url);
  if (!destination || context.insideLink) {
    return (
      <span key={key} className="sym-md-inert-link">
        {renderChildren(node, { ...context, insideLink: true }, depth, key)}
      </span>
    );
  }
  return (
    <ExternalLink key={key} destination={destination}>
      {renderChildren(node, { ...context, insideLink: true }, depth, key)}
    </ExternalLink>
  );
}

function cellAlignment(align: "left" | "right" | "center" | null | undefined) {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return "text-left";
}

function renderNode(
  node: RootContent,
  context: RenderContext,
  depth: number,
  key: string,
): ReactNode {
  if (depth > MAX_MARKDOWN_DEPTH) {
    return <Fragment key={key}>{plainText(node)}</Fragment>;
  }
  switch (node.type) {
    case "text":
      return <Fragment key={key}>{node.value}</Fragment>;
    case "paragraph":
      return <p key={key}>{renderChildren(node, context, depth, key)}</p>;
    case "heading": {
      const level = Math.min(6, context.headingLevelStart + node.depth - 1);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return <Tag key={key}>{renderChildren(node, context, depth, key)}</Tag>;
    }
    case "emphasis":
      return <em key={key}>{renderChildren(node, context, depth, key)}</em>;
    case "strong":
      return <strong key={key}>{renderChildren(node, context, depth, key)}</strong>;
    case "delete":
      return <del key={key}>{renderChildren(node, context, depth, key)}</del>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "code":
      return (
        <pre key={key}>
          <code
            {...(node.lang && /^[\w+#.-]{1,32}$/.test(node.lang)
              ? { "data-language": node.lang }
              : {})}
          >
            {node.value}
          </code>
        </pre>
      );
    case "break":
      return <br key={key} />;
    case "thematicBreak":
      return <hr key={key} />;
    case "blockquote":
      return <blockquote key={key}>{renderChildren(node, context, depth, key)}</blockquote>;
    case "list": {
      const items = renderChildren(node, context, depth, key);
      if (node.ordered) {
        return (
          <ol key={key} {...(node.start && node.start !== 1 ? { start: node.start } : {})}>
            {items}
          </ol>
        );
      }
      return <ul key={key}>{items}</ul>;
    }
    case "listItem": {
      const isTask = typeof node.checked === "boolean";
      return (
        <li key={key} {...(isTask ? { className: "sym-md-task" } : {})}>
          {isTask ? (
            <input
              type="checkbox"
              checked={node.checked === true}
              disabled
              readOnly
              aria-label={node.checked ? "Done" : "Not done"}
            />
          ) : null}
          {node.spread
            ? renderChildren(node, context, depth, key)
            : node.children.map((child, index) =>
                child.type === "paragraph" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: keys are tree paths of an immutable parse; siblings never reorder.
                  <Fragment key={`${key}.${index}`}>
                    {renderChildren(child, context, depth + 1, `${key}.${index}`)}
                  </Fragment>
                ) : (
                  renderNode(child, context, depth + 1, `${key}.${index}`)
                ),
              )}
        </li>
      );
    }
    case "link":
      return renderLink(node.url, node, context, depth, key);
    case "linkReference": {
      const definition = context.definitions.get(node.identifier);
      if (!definition) {
        return <Fragment key={key}>{renderChildren(node, context, depth, key)}</Fragment>;
      }
      return renderLink(definition.url, node, context, depth, key);
    }
    case "image":
      return renderImage(node.alt, node.url, key, context);
    case "imageReference": {
      const definition = context.definitions.get(node.identifier);
      return renderImage(node.alt, definition?.url ?? "", key, context);
    }
    case "html":
      // Raw HTML is disabled: it is shown as the literal source text, never parsed.
      return (
        <code key={key} className="sym-md-raw-html">
          {node.value}
        </code>
      );
    case "table": {
      const [head, ...body] = node.children;
      const alignFor = (index: number) => cellAlignment(node.align?.[index]);
      const cells = (row: TableRow, header: boolean, rowKey: string) =>
        row.children.map((cell: TableCell, index) => {
          const Cell = header ? "th" : "td";
          return (
            <Cell
              // biome-ignore lint/suspicious/noArrayIndexKey: keys are tree paths of an immutable parse; cells never reorder.
              key={`${rowKey}.${index}`}
              className={alignFor(index)}
              {...(header ? { scope: "col" } : {})}
            >
              {renderChildren(cell, context, depth + 2, `${rowKey}.${index}`)}
            </Cell>
          );
        });
      return (
        <div key={key} className="sym-md-table">
          <table>
            {head ? (
              <thead>
                <tr>{cells(head, true, `${key}.h`)}</tr>
              </thead>
            ) : null}
            <tbody>
              {body.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: keys are tree paths of an immutable parse; rows never reorder.
                <tr key={`${key}.${index}`}>{cells(row, false, `${key}.${index}`)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "footnoteReference":
      return (
        <sup key={key} className="sym-md-footnote-ref">
          [{node.label ?? node.identifier}]
        </sup>
      );
    case "footnoteDefinition":
      return (
        <div key={key} className="sym-md-footnote">
          <sup>[{node.label ?? node.identifier}]</sup> {renderChildren(node, context, depth, key)}
        </div>
      );
    case "definition":
      return null;
    default:
      return <Fragment key={key}>{plainText(node as Nodes)}</Fragment>;
  }
}

export interface SafeMarkdownProps {
  readonly source: string;
  readonly className?: string;
  /** The heading level a Markdown `#` renders as, so embedded content never outranks the page. */
  readonly headingLevelStart?: 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Renders untrusted Markdown (chat messages, tool activity, approval previews, notification text and
 * document previews, §10.4) by mapping the syntax tree to an allowlist of React elements. Raw HTML is
 * shown as text, remote images become labeled links and are never fetched, and links allow only
 * `https` and `mailto`, show their destination and use `rel="noopener noreferrer"`.
 */
export function SafeMarkdown({ source, className, headingLevelStart = 3 }: SafeMarkdownProps) {
  const content = useMemo(() => {
    const plain = <p className="whitespace-pre-wrap">{source}</p>;
    if (isMarkdownTooComplex(source)) return plain;
    try {
      const root = processor.parse(source);
      const context: RenderContext = {
        definitions: collectDefinitions(root),
        headingLevelStart,
        insideLink: false,
      };
      return root.children.map((child: RootContent, index) =>
        renderNode(child, context, 1, `${index}`),
      );
    } catch {
      // A parser failure on untrusted input (for example a stack overflow the pre-scan did not
      // predict) must never take down the surrounding view: show the source as text instead.
      return plain;
    }
  }, [source, headingLevelStart]);
  return <div className={cn("sym-markdown", className)}>{content}</div>;
}
