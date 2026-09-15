/** The global prefix of the app API (§6). */
export const globalPrefix = "v1";

/** Routes served without the `/v1` prefix (§6), in path-to-regexp v8 syntax. */
export const unprefixedRoutes = [
  "mcp",
  "oauth{/*path}",
  ".well-known{/*path}",
  "artifact{/*path}",
  "webhooks{/*path}",
  "internal{/*path}",
  "healthz",
] as const;

const exactUnprefixed: ReadonlySet<string> = new Set(["mcp", "healthz"]);
const unprefixedTrees: ReadonlySet<string> = new Set([
  "oauth",
  ".well-known",
  "artifact",
  "webhooks",
  "internal",
]);

/** Normalizes a route path: one leading slash, no duplicate or trailing slashes. */
export function normalizeRoutePath(path: string): string {
  const joined = `/${path}`.replace(/\/{2,}/g, "/");
  return joined.length > 1 && joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

/** Whether a controller path (without the prefix) is excluded from `/v1`, as `unprefixedRoutes` says. */
export function isUnprefixedPath(path: string): boolean {
  const normalized = normalizeRoutePath(path);
  const [first = ""] = normalized.slice(1).split("/");
  if (exactUnprefixed.has(first)) return normalized === `/${first}`;
  return unprefixedTrees.has(first);
}

/** The public path of a controller route, with the global prefix applied unless excluded. */
export function publicRoutePath(path: string): string {
  const normalized = normalizeRoutePath(path);
  return isUnprefixedPath(normalized)
    ? normalized
    : normalizeRoutePath(`${globalPrefix}${normalized}`);
}
