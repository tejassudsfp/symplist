import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const packagesDir = fileURLToPath(new URL("../../", import.meta.url));

/** The only entry points the web app may import (§2). */
const browserSafeEntries = {
  "@symplist/contracts": "contracts/src/index.ts",
  "@symplist/config/web": "config/src/web.ts",
  "@symplist/analytics": "analytics/src/index.ts",
  "@symplist/docs/markdown": "docs/src/markdown/index.ts",
} as const;

/**
 * Third-party packages that only run on the server (or would put server credentials and Node APIs
 * into the browser bundle). A package matches itself and its subpaths.
 */
const serverOnlyPackages = [
  "posthog-node",
  "@aws-sdk/",
  "@composio/core",
  "resend",
  "@nestjs/",
  "@trigger.dev/",
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/node",
  "@modelcontextprotocol/express",
  "express",
  "helmet",
  "cookie-parser",
  "@ai-sdk/openai",
  "@ai-sdk/amazon-bedrock",
  "@ai-sdk/google-vertex",
  "@ai-sdk/togetherai",
  "@ai-sdk/anthropic",
] as const;

const specifierPattern =
  /(?:^|[\s;])(?:import|export)\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

/** Every module specifier reachable from an entry through relative imports, with the file that uses it. */
function reachableSpecifiers(entryPath: string): Array<{ file: string; specifier: string }> {
  const seen = new Set<string>();
  const found: Array<{ file: string; specifier: string }> = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(specifierPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (specifier.startsWith(".")) {
        const exact = resolve(dirname(file), specifier);
        const target = exact.replace(/\.(?:js|ts|tsx)$/, "");
        const candidates = [exact, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`];
        const next = candidates.find((candidate) => {
          try {
            readFileSync(candidate);
            return true;
          } catch {
            return false;
          }
        });
        if (!next) throw new Error(`Unresolved import ${specifier} in ${file}`);
        visit(next);
      } else {
        found.push({ file, specifier });
      }
    }
  };
  visit(entryPath);
  return found;
}

function isServerOnlyPackage(specifier: string): boolean {
  return serverOnlyPackages.some((name) =>
    name.endsWith("/")
      ? specifier.startsWith(name)
      : specifier === name || specifier.startsWith(`${name}/`),
  );
}

/** The imports reachable from an entry that a browser bundle must never contain. */
function browserUnsafeImports(entryPath: string): Array<{ file: string; specifier: string }> {
  return reachableSpecifiers(entryPath).filter(
    ({ specifier }) =>
      specifier.startsWith("node:") ||
      isBuiltin(specifier) ||
      isServerOnlyPackage(specifier) ||
      (specifier.startsWith("@symplist/") && !(specifier in browserSafeEntries)),
  );
}

describe("browser-safe entry points (§2)", () => {
  it.each(Object.entries(browserSafeEntries))(
    "%s never imports node:*, server-only packages or server-only workspace code",
    (_name, entry) => {
      expect(browserUnsafeImports(resolve(packagesDir, entry))).toEqual([]);
    },
  );
});

describe("browser-safe import scan", () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), "symplist-browser-safe-"));
  afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

  const write = (relativePath: string, content: string) => {
    const path = join(fixtureDir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  it.each([
    ["posthog-node", 'import { PostHog } from "posthog-node";'],
    ["@aws-sdk/client-s3", 'import { S3Client } from "@aws-sdk/client-s3";'],
    ["@composio/core", 'export { Composio } from "@composio/core";'],
    ["resend", 'import "resend";'],
    ["node:crypto", 'const crypto = await import("node:crypto");'],
    ["fs", 'import { readFileSync } from "fs";'],
    ["@trigger.dev/sdk", 'import type { task } from "@trigger.dev/sdk";'],
    ["@symplist/db", 'import { createClient } from "@symplist/db";'],
  ])("fails an entry that reaches %s through a relative import", (specifier, statement) => {
    const name = specifier.replace(/[^a-z0-9]+/gi, "-");
    const entry = write(`${name}/index.ts`, 'export * from "./nested/util.ts";\n');
    write(
      `${name}/nested/util.ts`,
      `import { z } from "zod";\n${statement}\nexport const x = z;\n`,
    );
    expect(browserUnsafeImports(entry)).toEqual([
      { file: join(fixtureDir, name, "nested", "util.ts"), specifier },
    ]);
  });

  it("allows browser-safe dependencies and entries", () => {
    const entry = write(
      "safe/index.ts",
      [
        'import { z } from "zod";',
        'import { featureIds } from "@symplist/contracts";',
        'import posthog from "posthog-js";',
        'import { resendLike } from "./resend-like.ts";',
        "export { z, featureIds, posthog, resendLike };",
      ].join("\n"),
    );
    write(
      "safe/resend-like.ts",
      'import { toString } from "mdast-util-to-string";\nexport const resendLike = toString;\n',
    );
    expect(browserUnsafeImports(entry)).toEqual([]);
    expect(isServerOnlyPackage("resend-like")).toBe(false);
    expect(isServerOnlyPackage("expressive")).toBe(false);
    expect(isServerOnlyPackage("@ai-sdk/react")).toBe(false);
    expect(isServerOnlyPackage("@aws-sdk/s3-request-presigner")).toBe(true);
  });
});
