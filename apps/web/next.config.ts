import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
  // Stop `next dev` from writing AGENTS.md and CLAUDE.md into apps/web (§1).
  agentRules: false,
  turbopack: {
    resolveAlias: browserSafeWorkspaceEntries,
  },
};

export default nextConfig;
