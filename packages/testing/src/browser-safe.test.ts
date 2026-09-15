import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagesDir = fileURLToPath(new URL("../../", import.meta.url));

/** The only entry points the web app may import (§2). */
const browserSafeEntries = {
  "@symplist/contracts": "contracts/src/index.ts",
  "@symplist/config/web": "config/src/web.ts",
  "@symplist/analytics": "analytics/src/index.ts",
  "@symplist/docs/markdown": "docs/src/markdown/index.ts",
} as const;

const specifierPattern =
  /(?:^|[\s;])(?:import|export)\s(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** Every module specifier reachable from an entry through relative imports, with the file that uses it. */
function reachableSpecifiers(entry: string): Array<{ file: string; specifier: string }> {
  const seen = new Set<string>();
  const found: Array<{ file: string; specifier: string }> = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(specifierPattern)) {
      const specifier = match[1] ?? match[2];
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
  visit(resolve(packagesDir, entry));
  return found;
}

describe("browser-safe entry points (§2)", () => {
  it.each(Object.entries(browserSafeEntries))(
    "%s never imports node:* or server-only workspace code",
    (_name, entry) => {
      const offending = reachableSpecifiers(entry).filter(
        ({ specifier }) =>
          specifier.startsWith("node:") ||
          isBuiltin(specifier) ||
          (specifier.startsWith("@symplist/") && !(specifier in browserSafeEntries)),
      );
      expect(offending).toEqual([]);
    },
  );
});
