import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Source trees compiled by `tsc -b` and consumed from source by Vitest, Trigger and Turbopack. */
const sourceRoots = [
  ...readdirSync(join(repoRoot, "packages")).map((name) => join("packages", name, "src")),
  join("apps", "api", "src"),
];

function sourceFiles(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("relative import specifiers (§2.2)", () => {
  it("use .ts extensions, which tsc rewrites to .js on emit and Turbopack resolves from source", () => {
    const offending = sourceRoots
      .flatMap((root) => sourceFiles(join(repoRoot, root)))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/["'](\.{1,2}\/[^"'\n]+\.jsx?)["']/g)].map(
          (match) => `${relative(repoRoot, file)}: ${match[1]}`,
        ),
      );
    expect(offending).toEqual([]);
  });
});
