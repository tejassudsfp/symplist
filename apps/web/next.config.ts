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
  /**
   * The desktop shell (apps/desktop) runs this same app as a standalone Node server on 127.0.0.1 and
   * loads it in an Electron window, so the frontend exists once rather than twice (note 18, phase 2).
   * The flag is env-gated because the deployed build must keep emitting exactly what it emits today;
   * only `pnpm --filter @symplist/desktop build:web` sets it.
   */
  ...(process.env.SYMPLIST_DESKTOP === "1" ? { output: "standalone" as const } : {}),
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
