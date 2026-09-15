/**
 * Web security headers (§10.4). The Content Security Policy carries a per-request nonce, so it is set
 * by `proxy.ts` for every page request; the remaining headers are static and set in `next.config.ts`.
 */

export const NONCE_HEADER = "x-nonce";
export const CSP_HEADER = "Content-Security-Policy";
/** The OAuth consent route never sends a referrer (§10.4). */
export const OAUTH_CONSENT_PATH = "/oauth/consent";

export interface ContentSecurityPolicyOptions {
  readonly nonce: string;
  readonly apiOrigin: string | null;
  readonly wsOrigin: string | null;
  readonly posthogHost: string | null;
  /** `next dev` needs `'unsafe-eval'` for React debugging and inline dev styles. */
  readonly development: boolean;
}

const noncePattern = /^[A-Za-z0-9+/]{16,}={0,2}$/;

/** A fresh base64 nonce from 18 random bytes. */
export function createNonce(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sources(...values: ReadonlyArray<string | null | false>): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

/**
 * `default-src 'self'; script-src 'self' <nonce>; connect-src 'self' <API_ORIGIN> wss://<api host>
 * <POSTHOG_HOST>; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none';
 * form-action 'self' <API_ORIGIN>; frame-ancestors 'none'` (§10.4). Scripts use the nonce with
 * `'strict-dynamic'` (Next.js applies the nonce to its own scripts); style elements need the nonce,
 * and only style attributes (set by React and the panel and popup libraries) are allowed inline.
 */
export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  if (!noncePattern.test(options.nonce)) throw new Error("Invalid CSP nonce");
  const nonce = `'nonce-${options.nonce}'`;
  const directives: Array<[string, string]> = [
    ["default-src", "'self'"],
    [
      "script-src",
      sources("'self'", nonce, "'strict-dynamic'", options.development && "'unsafe-eval'"),
    ],
    ["style-src", sources("'self'", options.development ? "'unsafe-inline'" : nonce)],
    ["style-src-elem", sources("'self'", options.development ? "'unsafe-inline'" : nonce)],
    ["style-src-attr", "'unsafe-inline'"],
    [
      "connect-src",
      sources(
        "'self'",
        options.apiOrigin,
        options.wsOrigin,
        options.posthogHost,
        options.development && "ws:",
      ),
    ],
    ["img-src", "'self' data: blob:"],
    ["font-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", sources("'self'", options.apiOrigin)],
    ["frame-ancestors", "'none'"],
  ];
  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

export interface HeaderEntry {
  readonly key: string;
  readonly value: string;
}

/** Headers on every web route (§10.4). */
export const staticSecurityHeaders: readonly HeaderEntry[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

/** Extra headers on the OAuth consent route. */
export const oauthConsentHeaders: readonly HeaderEntry[] = [
  { key: "Referrer-Policy", value: "no-referrer" },
];
