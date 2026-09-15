import type { WebPublicConfig } from "@symplist/config/web";

/** Validated public origins for the browser (§16.2). Values are null when unset or invalid. */
export interface PublicOrigins {
  /** `https://api.example` (no path, no trailing slash). */
  readonly apiOrigin: string | null;
  /** `wss://api.example` for the realtime socket. */
  readonly wsOrigin: string | null;
  readonly posthogHost: string | null;
}

function origin(value: string | undefined, protocols: readonly string[]): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Parses public configuration; never throws, so a build without these values still compiles. */
export function parsePublicOrigins(config: Partial<WebPublicConfig>): PublicOrigins {
  return {
    apiOrigin: origin(config.NEXT_PUBLIC_API_URL, ["https:", "http:"]),
    wsOrigin: origin(config.NEXT_PUBLIC_WS_URL, ["wss:", "ws:"]),
    posthogHost: origin(config.NEXT_PUBLIC_POSTHOG_HOST, ["https:"]),
  };
}

/**
 * The public origins inlined at build time. Each `process.env.NEXT_PUBLIC_*` reference is written out
 * literally so Next.js can inline it into the client bundle.
 */
export function publicOrigins(): PublicOrigins {
  return parsePublicOrigins({
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  });
}
