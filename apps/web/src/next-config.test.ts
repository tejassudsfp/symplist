// @vitest-environment node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceSource } from "@symplist/testing/vitest";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

const webDir = fileURLToPath(new URL("..", import.meta.url));

describe("next.config.ts", () => {
  it("never writes agent rule files into apps/web", () => {
    expect(nextConfig.agentRules).toBe(false);
  });

  it("aliases exactly the browser-safe workspace entries to their package source exports (§2, §2.2)", () => {
    const aliases = nextConfig.turbopack?.resolveAlias ?? {};
    expect(Object.keys(aliases).sort()).toEqual([
      "@symplist/analytics",
      "@symplist/config/web",
      "@symplist/contracts",
      "@symplist/docs/markdown",
    ]);
    for (const [specifier, target] of Object.entries(aliases)) {
      expect(typeof target).toBe("string");
      const aliased = resolve(webDir, String(target));
      expect(existsSync(aliased)).toBe(true);
      expect(aliased).toBe(resolveWorkspaceSource(specifier));
    }
  });

  it("sends the static security headers on every route and no referrer on OAuth consent (§10.4)", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((rule) => rule.source === "/:path*");
    expect(all?.headers).toEqual(
      expect.arrayContaining([
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ]),
    );
    const consent = rules.find((rule) => rule.source === "/oauth/consent");
    expect(consent?.headers).toEqual([{ key: "Referrer-Policy", value: "no-referrer" }]);
    // The nonce-based CSP comes only from the proxy, so browsers never intersect two policies.
    for (const rule of rules) {
      expect(rule.headers.map((header) => header.key.toLowerCase())).not.toContain(
        "content-security-policy",
      );
    }
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
