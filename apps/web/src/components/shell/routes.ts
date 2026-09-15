import type { WorkspaceRoute } from "@/actions/types";

export type CollectionId = WorkspaceRoute["collection"];

export interface CollectionMeta {
  readonly id: CollectionId;
  readonly label: string;
  /** Compact label for the 390 px collection tabs. */
  readonly short: string;
  readonly href: `/${CollectionId}`;
  readonly shortcut: string;
}

/** The three rail collections in order (overall.md). */
export const collections: readonly CollectionMeta[] = [
  { id: "now", label: "Now", short: "Now", href: "/now", shortcut: "g n" },
  { id: "later", label: "Later", short: "Later", href: "/later", shortcut: "g l" },
  {
    id: "unclassified",
    label: "Unclassified",
    short: "Unclass.",
    href: "/unclassified",
    shortcut: "g u",
  },
];

const collectionIds = new Set<string>(collections.map((collection) => collection.id));
const taskIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** Parses `/now`, `/later/:taskId` and friends; any other path is not a workspace route. */
export function parseWorkspaceRoute(pathname: string | null | undefined): WorkspaceRoute | null {
  if (!pathname) return null;
  const segments = pathname.split("/").filter(Boolean);
  const [collection, taskId, ...rest] = segments;
  if (!collection || !collectionIds.has(collection) || rest.length > 0) return null;
  if (taskId !== undefined && !taskIdPattern.test(taskId)) return null;
  return { collection: collection as CollectionId, taskId: taskId ?? null };
}

export function collectionMeta(id: CollectionId): CollectionMeta {
  const meta = collections.find((collection) => collection.id === id);
  if (!meta) throw new Error(`Unknown collection ${id}`);
  return meta;
}

/**
 * Route groups that never load analytics: sign-in, the access gate, the Vault and OAuth consent.
 * Entering one from the app is a full document navigation (§15).
 */
const excludedPrefixes = ["/signin", "/access", "/vault", "/oauth/consent"] as const;

export function isExcludedRoute(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? href;
  return excludedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
