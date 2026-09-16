/**
 * Paths the documents feature links to. The history surface lives outside the workspace route
 * groups, so it carries a `from` parameter naming the task page it was entered from; Back returns
 * exactly there instead of guessing a collection (document_history brief).
 */

const collections = new Set(["now", "later", "unclassified"]);
const taskIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** `/tasks/:taskId/history`, with the entry page preserved when one is known. */
export function documentHistoryPath(taskId: string, from?: string | null): string {
  const base = `/tasks/${encodeURIComponent(taskId)}/history`;
  const origin = safeReturnPath(from);
  return origin ? `${base}?from=${encodeURIComponent(origin)}` : base;
}

/** `/tasks/:taskId/artifacts`, with the entry page preserved when one is known. */
export function taskArtifactsPath(taskId: string, from?: string | null): string {
  const base = `/tasks/${encodeURIComponent(taskId)}/artifacts`;
  const origin = safeReturnPath(from);
  return origin ? `${base}?from=${encodeURIComponent(origin)}` : base;
}

/**
 * A `from` value this app is willing to navigate back to: an in-app task page path and nothing else.
 * Anything absolute, protocol-relative or outside the three collections is refused, so a crafted link
 * can never turn Back into an off-site navigation.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  const [path] = value.split(/[?#]/);
  if (path === undefined) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const [collection, taskId] = segments as [string, string];
  if (!collections.has(collection) || !taskIdPattern.test(taskId)) return null;
  return `/${collection}/${taskId}`;
}

/** The task page a history screen returns to: its `from` when valid, else the Now collection. */
export function backToPageHref(taskId: string, from?: string | null): string {
  return safeReturnPath(from) ?? `/now/${encodeURIComponent(taskId)}`;
}
