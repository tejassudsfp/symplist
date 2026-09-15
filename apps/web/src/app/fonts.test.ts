// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fontVariable } from "../theme/css.ts";
import {
  DEFAULT_THEME_ID,
  type FontFamilyId,
  fontFamilyIds,
  themeIds,
  themes,
} from "../theme/registry.ts";

/** The options object of one `next/font/local` call, as `app/fonts.ts` writes it. */
interface LocalFontCall {
  readonly src: ReadonlyArray<{
    readonly path: string;
    readonly weight: string;
    readonly style: string;
  }>;
  readonly variable: string;
  readonly display: string;
  readonly preload: boolean;
  readonly declarations?: ReadonlyArray<{ readonly prop: string; readonly value: string }>;
  readonly fallback?: readonly string[];
  readonly adjustFontFallback?: false | "Arial" | "Times New Roman";
}

// next/font/local only runs inside the Next compiler; recording its options gives the exact manifest.
const recorded = vi.hoisted(() => ({ calls: [] as LocalFontCall[] }));
vi.mock("next/font/local", () => ({
  default: (options: LocalFontCall) => {
    recorded.calls.push(options);
    return { className: "", variable: `variable-of${options.variable}`, style: {} };
  },
}));

const appDir = fileURLToPath(new URL(".", import.meta.url));
const webDir = join(appDir, "..", "..");
const fontsSource = readFileSync(join(appDir, "fonts.ts"), "utf8");
const stacksCss = readFileSync(join(appDir, "..", "theme", "fonts.css"), "utf8");
const notices = readFileSync(join(webDir, "public", "licenses", "fonts.txt"), "utf8");
const require = createRequire(import.meta.url);

const subsets = ["latin", "latin-ext", "vietnamese"] as const;
type Subset = (typeof subsets)[number];

/** Characters from Polish, Romanian and Vietnamese text that the extended subsets must cover. */
const sampleCharacters = ["Ł", "ș", "ễ"] as const;

/**
 * Gaps that no Fontsource package can close: DM Sans 5.3.0 ships only latin and latin-ext, so Meadow's
 * interface text renders Vietnamese letters outside latin-ext with the theme's fallback stack.
 */
const upstreamGaps = new Set(["dm-sans ễ"]);

interface FontkitFont {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

/** fontkit as bundled with Next.js, the library next/font itself reads these files with. */
function openFont(path: string): FontkitFont {
  const module = require("next/dist/compiled/@next/font/dist/fontkit/index.js") as {
    default: ((buffer: Buffer) => FontkitFont) | { default: (buffer: Buffer) => FontkitFont };
  };
  const create = typeof module.default === "function" ? module.default : module.default.default;
  return create(readFileSync(path));
}

function packageOf(path: string): string {
  const match = /node_modules\/(@fontsource(?:-variable)?\/[^/]+)\/files\//.exec(path);
  if (!match?.[1]) throw new Error(`Not a Fontsource file: ${path}`);
  return match[1];
}

function packageJson<T>(name: string, file: string): T {
  return JSON.parse(readFileSync(join(webDir, "node_modules", name, file), "utf8")) as T;
}

/** Whether a CSS `unicode-range` value (`U+0000-00FF,U+0131,…`) includes a code point. */
function rangeIncludes(range: string, codePoint: number): boolean {
  return range.split(",").some((part) => {
    const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(part.trim());
    if (!match?.[1]) throw new Error(`Unsupported unicode-range entry: ${part}`);
    const start = Number.parseInt(match[1], 16);
    const end = match[2] === undefined ? start : Number.parseInt(match[2], 16);
    return codePoint >= start && codePoint <= end;
  });
}

function unicodeRangeOf(call: LocalFontCall): string {
  const ranges = (call.declarations ?? []).filter((entry) => entry.prop === "unicode-range");
  if (ranges.length !== 1 || !ranges[0])
    throw new Error(`${call.variable} needs one unicode-range`);
  return ranges[0].value;
}

let fontVariableClassNames = "";
const callsByVariable = new Map<string, LocalFontCall>();

function callFor(family: FontFamilyId, subset: Subset): LocalFontCall | undefined {
  return callsByVariable.get(`${fontVariable(family)}-${subset}`);
}

function latinCall(family: FontFamilyId): LocalFontCall {
  const call = callFor(family, "latin");
  if (!call) throw new Error(`${family} has no latin subset`);
  return call;
}

/** The subsets of a family's Fontsource package among latin, latin-ext and vietnamese. */
function shippedSubsets(family: FontFamilyId): Subset[] {
  const name = packageOf(latinCall(family).src[0]?.path ?? "");
  const metadata = packageJson<{ subsets: string[] }>(name, "metadata.json");
  return subsets.filter((subset) => metadata.subsets.includes(subset));
}

beforeAll(async () => {
  ({ fontVariableClassNames } = await import("./fonts.ts"));
  for (const call of recorded.calls) callsByVariable.set(call.variable, call);
});

describe("self-hosted fonts (§10.3)", () => {
  it("loads only local Fontsource files that exist, never next/font/google", () => {
    expect(fontsSource).toContain('from "next/font/local"');
    expect(fontsSource).not.toContain("next/font/google");
    expect(recorded.calls.length).toBeGreaterThan(0);
    expect(callsByVariable.size).toBe(recorded.calls.length);
    for (const call of recorded.calls) {
      expect(call.src.length).toBeGreaterThan(0);
      expect(call.display).toBe("swap");
      for (const face of call.src) {
        expect(face.path).toMatch(
          /^\.\.\/\.\.\/node_modules\/@fontsource(-variable)?\/[^/]+\/files\//,
        );
        expect(existsSync(join(appDir, face.path)), face.path).toBe(true);
      }
    }
  });

  it("loads latin, latin-ext and every vietnamese subset Fontsource ships for each theme family", () => {
    const used = new Set(
      themeIds.flatMap((id) => Object.values(themes[id].fonts).map((role) => role.family)),
    );
    expect([...used].sort()).toEqual([...fontFamilyIds].sort());

    const expectedVariables: string[] = [];
    for (const family of fontFamilyIds) {
      const latin = latinCall(family);
      const name = packageOf(latin.src[0]?.path ?? "");
      const ranges = packageJson<Record<string, string>>(name, "unicode.json");
      const familySubsets = shippedSubsets(family);
      expect(familySubsets.slice(0, 2)).toEqual(["latin", "latin-ext"]);
      for (const subset of familySubsets) {
        const call = callFor(family, subset);
        expect(call, `${family} ${subset}`).toBeDefined();
        if (!call) continue;
        expectedVariables.push(call.variable);
        expect(unicodeRangeOf(call)).toBe(ranges[subset]);
        // The same faces as the latin subset, from the subset's own files.
        expect(call.src).toEqual(
          latin.src.map((face) => ({
            ...face,
            path: face.path.replace(/-latin-(?=[^/]+\.woff2$)/, `-${subset}-`),
          })),
        );
        if (subset === "latin") {
          expect(call.fallback?.length).toBeGreaterThan(0);
        } else {
          // Extended subsets add no fallback of their own: the latin variable, last in the stack,
          // carries the metric-adjusted and generic fallbacks.
          expect(call.fallback).toBeUndefined();
          expect(call.adjustFontFallback).toBe(false);
        }
      }
    }
    expect([...callsByVariable.keys()].sort()).toEqual(expectedVariables.sort());
    expect(fontVariableClassNames.split(" ").sort()).toEqual(
      expectedVariables.map((variable) => `variable-of${variable}`).sort(),
    );
  });

  it("composes each family stack with its extended subsets before latin", () => {
    const declared = new Map(
      [...stacksCss.matchAll(/(--font-[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [
        match[1],
        (match[2] ?? "").replace(/\s+/g, " ").trim(),
      ]),
    );
    expect([...declared.keys()].sort()).toEqual(
      fontFamilyIds.map((family) => fontVariable(family)).sort(),
    );
    for (const family of fontFamilyIds) {
      const order = [...shippedSubsets(family).filter((subset) => subset !== "latin"), "latin"];
      expect(declared.get(fontVariable(family))).toBe(
        order.map((subset) => `var(${fontVariable(family)}-${subset})`).join(", "),
      );
    }
  });

  it("preloads only the default theme's latin faces", () => {
    const defaultFamilies = new Set(
      Object.values(themes[DEFAULT_THEME_ID].fonts).map((role) => role.family),
    );
    const preloaded = recorded.calls.filter((call) => call.preload).map((call) => call.variable);
    expect(preloaded.sort()).toEqual(
      [...defaultFamilies].map((family) => `${fontVariable(family)}-latin`).sort(),
    );
  });

  it("covers Ł, ș and ễ in every theme's interface, heading and mono fonts", () => {
    const gaps = new Set<string>();
    for (const themeId of themeIds) {
      for (const [role, { family }] of Object.entries(themes[themeId].fonts)) {
        for (const character of sampleCharacters) {
          const codePoint = character.codePointAt(0) ?? 0;
          const covering = shippedSubsets(family)
            .map((subset) => callFor(family, subset))
            .filter((call): call is LocalFontCall => call !== undefined)
            .filter((call) => rangeIncludes(unicodeRangeOf(call), codePoint));
          const label = `${themeId} ${role} ${family} ${character}`;
          if (covering.length === 0) {
            gaps.add(`${family} ${character}`);
            continue;
          }
          // Every face the browser may pick for the character (each weight and style) has its glyph.
          for (const face of covering.flatMap((call) => call.src)) {
            expect(openFont(join(appDir, face.path)).hasGlyphForCodePoint(codePoint), label).toBe(
              true,
            );
          }
        }
      }
    }
    expect(gaps).toEqual(upstreamGaps);
  });

  it("records only gaps that no shipped file of the family could close", () => {
    for (const gap of upstreamGaps) {
      const [family, character] = gap.split(" ") as [FontFamilyId, string];
      expect(shippedSubsets(family)).not.toContain("vietnamese");
      const name = packageOf(latinCall(family).src[0]?.path ?? "");
      const files = readdirSync(join(webDir, "node_modules", name, "files"));
      expect(files.filter((file) => file.includes("vietnamese"))).toEqual([]);
      for (const call of recorded.calls.filter(
        (entry) => packageOf(entry.src[0]?.path ?? "") === name,
      )) {
        for (const face of call.src) {
          expect(
            openFont(join(appDir, face.path)).hasGlyphForCodePoint(character.codePointAt(0) ?? 0),
          ).toBe(false);
        }
      }
    }
  });

  it("ships the OFL notice, license text and subset list of every packaged font", () => {
    const packages = new Set(
      recorded.calls.flatMap((call) => call.src.map((face) => packageOf(face.path))),
    );
    expect(packages.size).toBe(fontFamilyIds.length);
    for (const family of fontFamilyIds) {
      const name = packageOf(latinCall(family).src[0]?.path ?? "");
      const manifest = packageJson<{ version: string; license: string }>(name, "package.json");
      expect(manifest.license).toBe("OFL-1.1");
      const heading = `(${name} ${manifest.version})`;
      expect(notices).toContain(heading);
      const section = notices.slice(notices.indexOf(heading));
      expect(section).toMatch(
        new RegExp(
          `^\\(${name.replace(/[/.-]/g, "\\$&")} [^)]+\\)\\n=+\\n\\nSubsets: ${shippedSubsets(family).join(", ")}\\n`,
        ),
      );
      const license = readFileSync(join(webDir, "node_modules", name, "LICENSE"), "utf8");
      expect(notices).toContain(license.trim());
    }
    expect(notices).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});
