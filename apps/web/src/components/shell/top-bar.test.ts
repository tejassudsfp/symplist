// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every profile-menu destination must be a route that exists.
 *
 * "Connections" outlived the page it pointed at when the connector layer was deleted, so the menu
 * offered a link that went nowhere. Reading the routes off the filesystem means a deleted page fails
 * here instead of in someone's dropdown.
 */
const source = readFileSync(fileURLToPath(new URL("./top-bar.tsx", import.meta.url)), "utf8");
const appDir = fileURLToPath(new URL("../../app/", import.meta.url));

/** Route groups are parenthesised directories that do not appear in the URL, so try each of them. */
const groups = [
  "",
  ...readdirSync(appDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("("))
    .map((entry) => `${entry.name}/`),
];

function routeExists(href: string): boolean {
  const path = href.replace(/^\//, "");
  return groups.some((group) => existsSync(`${appDir}${group}${path}/page.tsx`));
}

const hrefs = [...source.matchAll(/href: "(\/[^"]*)"/g)].map((match) => match[1] as string);

describe("the profile menu", () => {
  it("finds the menu's destinations", () => {
    expect(hrefs.length).toBeGreaterThan(4);
  });

  it.each(hrefs)("%s is a real page", (href) => {
    expect(routeExists(href)).toBe(true);
  });

  it("no longer offers the deleted connector page", () => {
    expect(source).not.toContain("/settings/connections");
  });
});
