import { type NextRequest, NextResponse } from "next/server";
import { parsePublicOrigins } from "./lib/public-config.ts";
import {
  buildContentSecurityPolicy,
  CSP_HEADER,
  createNonce,
  NONCE_HEADER,
} from "./lib/security/headers.ts";

/**
 * The api's non-secret presence cookie (§5.1). It carries no session, only "someone signed in on this
 * device", and the api remains the only authority.
 */
export const SESSION_HINT_COOKIE = "sym_hint";

/** Route prefixes a signed-out visitor may open. Everything else starts at the email entry. */
const publicPrefixes = ["/signin"] as const;

function isPublicPath(pathname: string): boolean {
  return publicPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** The path to return to after signing in: a same-origin path, never sign-in itself. */
function nextParamFor(request: NextRequest): string | null {
  const { pathname, search } = request.nextUrl;
  if (pathname === "/" || pathname === "/now") return null;
  const value = `${pathname}${search}`;
  return value.length > 1024 ? null : value;
}

/**
 * Sets the per-request Content Security Policy nonce (§10.4) and redirects visitors with no session
 * hint to the email entry (§5.1). The redirect is an optimistic check on a non-secret cookie only —
 * it never reads a session, never calls the api, and every screen behind it checks access again with
 * `GET /v1/me`, which is what actually decides what renders.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = createNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    ...parsePublicOrigins({
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
      NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
      NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    }),
    development: process.env.NODE_ENV === "development",
  });

  const { pathname } = request.nextUrl;
  if (!isPublicPath(pathname) && !request.cookies.has(SESSION_HINT_COOKIE)) {
    const signIn = new URL("/signin", request.nextUrl);
    const next = nextParamFor(request);
    if (next) signIn.searchParams.set("next", next);
    const redirect = NextResponse.redirect(signIn);
    redirect.headers.set(CSP_HEADER, policy);
    return redirect;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, policy);
  return response;
}

export const config = {
  // Brand assets and metadata must load before sign-in so browsers can show the favicon and PWA icon.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico$|icon\\.svg$|apple-icon\\.png$|manifest\\.webmanifest$|brand/|licenses/).*)",
  ],
};
