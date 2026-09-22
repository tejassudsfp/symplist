import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import {
  OAUTH_CONSENT_PATH,
  oauthConsentHeaders,
  staticSecurityHeaders,
} from "./src/lib/security/headers.ts";

/**
 * The only workspace entry points the web app may import (§2), aliased to their TypeScript sources so
 * `next build` never needs a package `dist` (§2.2).
 */
const browserSafeWorkspaceEntries = {
  "@symplist/contracts": "../../packages/contracts/src/index.ts",
  "@symplist/config/web": "../../packages/config/src/web.ts",
  "@symplist/analytics": "../../packages/analytics/src/index.ts",
  "@symplist/docs/markdown": "../../packages/docs/src/markdown/index.ts",
};

const browserSafeWorkspacePaths = Object.fromEntries(
  Object.entries(browserSafeWorkspaceEntries).map(([specifier, target]) => [
    specifier,
    fileURLToPath(new URL(target, import.meta.url)),
  ]),
);

const nextConfig: NextConfig = {
  // Stop `next dev` from writing AGENTS.md and CLAUDE.md into apps/web (§1).
  agentRules: false,
  poweredByHeader: false,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "logos.composio.dev", pathname: "/api/**" }],
  },
  turbopack: {
    resolveAlias: browserSafeWorkspaceEntries,
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      ...browserSafeWorkspacePaths,
    };
    return config;
  },
  // Static security headers on every route (§10.4). The nonce-based Content Security Policy is set
  // per request by `src/proxy.ts`.
  async headers() {
    return [
      { source: "/:path*", headers: [...staticSecurityHeaders] },
      { source: OAUTH_CONSENT_PATH, headers: [...oauthConsentHeaders] },
    ];
  },
};

export default nextConfig;
