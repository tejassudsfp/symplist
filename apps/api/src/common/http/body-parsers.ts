import type { ApiConfig } from "@symplist/config/api";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";

const KIB = 1024;

/**
 * The largest JSON body an authenticated route accepts: a whole document (`DOC_MAX_BYTES`) with
 * escaping overhead (§3.2), plus room for the request's other fields.
 */
export function jsonBodyLimitBytes(config: Pick<ApiConfig, "DOC_MAX_BYTES">): number {
  return config.DOC_MAX_BYTES * 2 + 64 * KIB;
}

/** One path family's body limit, in bytes. */
export interface BodyLimitRule {
  /** A path prefix (with its trailing slash) or an exact path, matched before any routing. */
  readonly path: string;
  readonly match: "prefix" | "exact";
  readonly limitBytes: number;
}

/**
 * Body limits for routes a client reaches before it holds any credential (§3.1, §5.3): these are
 * parsed with small limits so an unauthenticated caller can never make the api buffer and parse a
 * document-sized body. Every other path (the cookie-authenticated `/v1/*` routes, `/mcp` with its
 * bearer check) keeps {@link jsonBodyLimitBytes}.
 *
 * - `/v1/auth/*`: lookup, signup and OTP bodies hold an email address, a challenge id and a code.
 * - `/oauth/*`: token requests are small forms; dynamic registration holds client metadata with a
 *   handful of redirect URIs.
 * - `/webhooks/*`: Resend delivery events and Composio account lifecycle events, verified over the raw
 *   body before anything else.
 * - `/artifact/*`: the share-host password form (`key`, `nonce`, `password`).
 * - `/internal/*`: worker requests use their own media type and are read by the internal controllers
 *   with their own limits (events 64 KiB, run output 2 MiB), so a JSON or form body there is never
 *   valid and is refused before it is buffered.
 * - `/.well-known/*` and `/healthz`: read-only, no body.
 */
export const unauthenticatedBodyLimits: readonly BodyLimitRule[] = Object.freeze([
  { path: "/v1/auth/", match: "prefix", limitBytes: 16 * KIB },
  { path: "/oauth/", match: "prefix", limitBytes: 64 * KIB },
  { path: "/webhooks/", match: "prefix", limitBytes: 256 * KIB },
  { path: "/artifact/", match: "prefix", limitBytes: 16 * KIB },
  { path: "/internal/", match: "prefix", limitBytes: 1 * KIB },
  { path: "/.well-known/", match: "prefix", limitBytes: 1 * KIB },
  { path: "/healthz", match: "exact", limitBytes: 1 * KIB },
] satisfies BodyLimitRule[]);

/**
 * The body limit of a request path: the first matching unauthenticated rule, else the default.
 * Express routes case-insensitively, so paths are compared lower-cased: `/V1/Auth/lookup` reaches the
 * lookup route and must get its limit.
 */
export function bodyLimitFor(path: string, defaultLimitBytes: number): number {
  const lower = path.toLowerCase();
  for (const rule of unauthenticatedBodyLimits) {
    const matches =
      rule.match === "exact"
        ? lower === rule.path || lower === `${rule.path}/`
        : lower.startsWith(rule.path) || lower === rule.path.slice(0, -1);
    if (matches) return rule.limitBytes;
  }
  return defaultLimitBytes;
}

/** Keeps the exact request bytes for signature checks (webhooks, §6.2), as Nest's `rawBody` does. */
function keepRawBody(req: Request, _res: Response, buffer: Buffer): void {
  if (Buffer.isBuffer(buffer)) (req as Request & { rawBody?: Buffer }).rawBody = buffer;
}

/**
 * Builds a parser per distinct limit once, and dispatches each request to the parser of its path.
 * Named like body-parser's own middleware so Nest never registers a second default parser.
 */
function pathLimitedParser(
  name: "jsonParser" | "urlencodedParser",
  create: (limitBytes: number) => RequestHandler,
  defaultLimitBytes: number,
): RequestHandler {
  const parsers = new Map<number, RequestHandler>();
  for (const limit of [
    defaultLimitBytes,
    ...unauthenticatedBodyLimits.map((rule) => rule.limitBytes),
  ]) {
    if (!parsers.has(limit)) parsers.set(limit, create(limit));
  }
  const handlers = {
    [name]: (req: Request, res: Response, next: NextFunction): void => {
      const parser = parsers.get(bodyLimitFor(req.path, defaultLimitBytes));
      if (!parser) {
        next(new Error("No body parser for the request path"));
        return;
      }
      parser(req, res, next);
    },
  };
  return handlers[name] as RequestHandler;
}

/**
 * The api's JSON and URL-encoded body parsers with per-path limits (§3.1, §6). Register both before
 * any route; create the application with `bodyParser: false` so Nest adds no parser of its own. Forms
 * parse flat (`extended: false`): no form the api accepts nests values. Oversized bodies fail with
 * `request.too_large` before they are buffered when `Content-Length` declares them, and as soon as
 * the limit is crossed otherwise.
 */
export function bodyParsers(config: Pick<ApiConfig, "DOC_MAX_BYTES">): readonly RequestHandler[] {
  const defaultLimit = jsonBodyLimitBytes(config);
  return [
    pathLimitedParser(
      "jsonParser",
      (limit) => express.json({ limit, verify: keepRawBody }),
      defaultLimit,
    ),
    pathLimitedParser(
      "urlencodedParser",
      (limit) => express.urlencoded({ limit, extended: false, verify: keepRawBody }),
      defaultLimit,
    ),
  ];
}
