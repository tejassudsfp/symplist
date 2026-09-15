// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fontVariable } from "../theme/css.ts";
import { fontFamilyIds, themeIds, themes } from "../theme/registry.ts";

const appDir = fileURLToPath(new URL(".", import.meta.url));
const webDir = join(appDir, "..", "..");
const fontsSource = readFileSync(join(appDir, "fonts.ts"), "utf8");
const notices = readFileSync(join(webDir, "public", "licenses", "fonts.txt"), "utf8");

describe("self-hosted fonts (§10.3)", () => {
  const paths = [...fontsSource.matchAll(/"(\.\.\/\.\.\/node_modules\/[^"]+\.woff2)"/g)].map(
    (match) => match[1] as string,
  );

  it("loads only local Fontsource files that exist, never next/font/google", () => {
    expect(fontsSource).toContain('from "next/font/local"');
    expect(fontsSource).not.toContain("next/font/google");
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(join(appDir, path)), path).toBe(true);
  });

  it("defines a CSS variable for every family a theme uses", () => {
    const used = new Set(
      themeIds.flatMap((id) => Object.values(themes[id].fonts).map((role) => role.family)),
    );
    expect([...used].sort()).toEqual([...fontFamilyIds].sort());
    for (const family of used) expect(fontsSource).toContain(`variable: "${fontVariable(family)}"`);
  });

  it("ships the OFL notice and license text of every packaged font", () => {
    const packages = new Set(
      paths.map((path) => /node_modules\/(@fontsource(?:-variable)?\/[^/]+)\//.exec(path)?.[1]),
    );
    expect(packages.size).toBe(fontFamilyIds.length);
    for (const name of packages) {
      if (!name) throw new Error("unparsed font package");
      const manifest = JSON.parse(
        readFileSync(join(webDir, "node_modules", name, "package.json"), "utf8"),
      ) as {
        version: string;
        license: string;
      };
      expect(manifest.license).toBe("OFL-1.1");
      expect(notices).toContain(`(${name} ${manifest.version})`);
      const license = readFileSync(join(webDir, "node_modules", name, "LICENSE"), "utf8");
      expect(notices).toContain(license.trim());
    }
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});
