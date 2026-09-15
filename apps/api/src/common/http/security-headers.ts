import type { HelmetOptions } from "helmet";

/**
 * Helmet settings for the api host (§10.4): a CSP that allows nothing to load or frame the JSON api
 * (`frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, HSTS for
 * two years with subdomains and `Referrer-Policy: no-referrer`. Share-host responses replace the CSP
 * with their own (§13.4).
 */
export const apiHelmetOptions: Readonly<HelmetOptions> = Object.freeze({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true },
  referrerPolicy: { policy: "no-referrer" },
  xFrameOptions: { action: "deny" },
  xContentTypeOptions: true,
  crossOriginResourcePolicy: { policy: "same-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
} satisfies HelmetOptions);
