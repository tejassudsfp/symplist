import { type NextRequest, NextResponse } from "next/server";
import { parsePublicOrigins } from "./lib/public-config.ts";
import {
  buildContentSecurityPolicy,
  CSP_HEADER,
  createNonce,
  NONCE_HEADER,
} from "./lib/security/headers.ts";

/**
 * Sets the per-request Content Security Policy nonce (§10.4). Next.js reads the nonce from the request's
 * CSP header and applies it to its scripts; the root layout reads `x-nonce` for the appearance
 * stylesheet and Base UI. This proxy never performs authentication.
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
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, policy);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|licenses/).*)"],
};
