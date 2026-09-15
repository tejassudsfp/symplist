// @vitest-environment node
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../../../", import.meta.url));

function files(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const apiImport =
  /from\s+["'](?:@\/lib\/(?:api|realtime)[^"']*|(?:\.\.?\/)+(?:lib\/)?(?:api|realtime)(?:\/[^"']*)?)["']/;

describe("the web app never calls the API from server code (§5.1)", () => {
  it("keeps lib/api and lib/realtime out of server components, route files, proxy and config", () => {
    const serverFiles = [
      ...files(join(webRoot, "src", "app")),
      join(webRoot, "src", "proxy.ts"),
      join(webRoot, "next.config.ts"),
    ];
    const offending = serverFiles.filter((file) => {
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        return false;
      }
      const isClient = /^\s*["']use client["']/.test(source);
      return !isClient && apiImport.test(source);
    });
    expect(offending.map((file) => relative(webRoot, file))).toEqual([]);
  });

  it("never uses next/headers cookies to forward credentials to the API", () => {
    const offending = files(join(webRoot, "src")).filter((file) => {
      const source = readFileSync(file, "utf8");
      return /cookies\(\)[\s\S]*toString\(\)/.test(source) || /apiFetchServer/.test(source);
    });
    expect(offending.map((file) => relative(webRoot, file))).toEqual([]);
  });
});
