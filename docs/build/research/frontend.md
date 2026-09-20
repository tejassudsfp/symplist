# Frontend research (verified 2026-09-15)

Scope: the Next.js web app on Vercel. That covers React and its types, TypeScript 7 compatibility, Tailwind CSS v4, the shadcn CLI and its primitives (Base UI vs Radix), icons, resizable panels, drag and drop for the task tree, OKLCH accent derivation with WCAG contrast, self-hosted fonts, unit and E2E testing, and how the browser and Next server talk to the NestJS API on a sibling subdomain with cookies.

Method:
- Versions come from `npm view <pkg> version` plus `peerDependencies engines`, and dist-tags were checked (only `latest` is used). API facts come from the official docs quoted below, cross-checked against the published `.d.ts`/JS inside the tarballs.
- Everything under "Verified APIs" was compiled and run in a throwaway scratch app, not in this repo:
  - `next build` with Turbopack and the TypeScript 7.0.2 CLI check
  - `next dev` and `next start`
  - Vitest 5.0.1 in jsdom and happy-dom
  - a Playwright 1.63.0 Chromium run
- Toolchain: Node 24.15.0. The scratch installs ran with the machine's global pnpm (11.1.2) because the scratch dir sits outside the workspace. The repo itself pins `pnpm@12.4.2`.

## Versions

| package | version | peer/engine notes |
| --- | --- | --- |
| `next` | 16.3.5 | peers `react`/`react-dom` `^18.2.0 \|\| ^19.0.0`; optional peers `@playwright/test ^1.51.1`, `sass`, `@opentelemetry/api`, `babel-plugin-react-compiler`; engines `node >=20.9.0`. Published 2026-09-11. App Router renders with Next's vendored React `19.3.0-canary-cbb046ab-20260731` (from `next/dist/compiled/react`). |
| `react` | 19.3.0 | engines `node >=0.10.0`; published 2026-09-09 (React 19.3 blog: View Transitions stable, Fragment Refs, `browser()`) |
| `react-dom` | 19.3.0 | peer `react ^19.3.0` |
| `@types/react` | 19.3.0 | no peers |
| `@types/react-dom` | 19.3.0 | peer `@types/react ^19.3.0` |
| `@types/node` | 24.13.4 | newest 24.x (26.5.1 is overall latest; stay on 24.x to match Node 24 LTS) |
| `typescript` | 7.0.2 | engines `node >=16.20.0`. Package `exports["."]` is `./lib/version.cjs` (only `version`, `versionMajorMinor`) plus `./unstable/*`; there is **no** `lib/typescript.js` compiler API |
| `typescript` (fallback) | 6.0.3 | newest 6.x; alias package `@typescript/typescript6` is 6.0.2 (bin `tsc6`) |
| `tailwindcss` | 4.3.3 | no peers; published 2026-07-16 |
| `@tailwindcss/postcss` | 4.3.3 | no peers |
| `postcss` | 8.5.28 | listed in Tailwind's Next install command |
| `shadcn` (CLI) | 4.21.0 | engines `node >=20.18.1`; ships its own TypeScript through `ts-morph ^26` (does not use the project's TS). `init` adds `shadcn` as a runtime dependency because `globals.css` imports `shadcn/tailwind.css` |
| `@base-ui/react` | 1.8.0 | peers `react`/`react-dom` `^17 \|\| ^18 \|\| ^19`; optional `@types/react`, `date-fns ^4`, `@date-fns/tz ^1.2` |
| `radix-ui` | 1.6.7 | alternative primitives (`shadcn init -b radix`); peers react 16.8 to 19 |
| `cn` | 0.3.0 | MIT, repo shadcn-ui/cn; replaces `clsx` + `tailwind-merge` in shadcn since 2026-09 |
| `class-variance-authority` | 0.7.1 | added by `shadcn init` |
| `tw-animate-css` | 1.4.0 | added by `shadcn init` |
| `next-themes` | 0.4.6 | pulled in by the shadcn `sonner` component; peers react `^16.8 ... ^19` |
| `sonner` | 2.0.8 | shadcn toast component dependency |
| `lucide-react` | 1.46.0 | peer `react ^16.5.1 ... ^19.0.0`. v1 removed brand icons, dropped UMD, and sets `aria-hidden` by default. Published 2026-09-14T09:23Z |
| `react-resizable-panels` | 4.12.4 | peers `react`/`react-dom` `^18 \|\| ^19`; v4 API is `Group`/`Panel`/`Separator` |
| `@dnd-kit/react` | 0.5.0 | peers `react`/`react-dom` `^18 \|\| ^19`; deps `@dnd-kit/abstract`, `@dnd-kit/dom`, `@dnd-kit/state` 0.5.0. `latest` tag; a `beta` tag (0.5.1-beta-20260912195958) exists and is not used. Pre-1.0 |
| `@dnd-kit/dom` | 0.5.0 | import source for `Accessibility`, `KeyboardSensor`, event types |
| `@dnd-kit/helpers` | 0.5.0 | `move`, `swap`, `arrayMove`, `arraySwap` |
| `@dnd-kit/core` / `@dnd-kit/sortable` | 6.3.1 / 10.0.0 | legacy line, last published 2024-12-05; not recommended (see decisions) |
| `culori` | 4.0.2 | MIT; `"type": "module"` with a CJS bundle; engines `node >=16`; published 2025-06-27 |
| `@types/culori` | 4.0.1 | types for the above |
| `colorjs.io` | 0.7.1 | MIT; considered, not chosen |
| `@fontsource-variable/geist`, `geist-mono`, `source-sans-3`, `source-serif-4`, `nunito`, `public-sans`, `dm-sans`, `fraunces`, `manrope` | 5.3.0 (all) | npm `license: OFL-1.1`; each tarball's `LICENSE` is the SIL Open Font License 1.1 (checked) |
| `@fontsource/ibm-plex-mono` | 5.3.0 | `OFL-1.1` (LICENSE checked; Copyright 2017 IBM Corp.). Static weights 100 to 700, normal + italic. `@fontsource-variable/ibm-plex-mono` does not exist (npm 404) |
| `geist` | 1.7.2 | peer `next >=13.2.0`; license field "SIL OPEN FONT LICENSE"; wraps `next/font/local` (`GeistSans` exposes `--font-geist-sans`) |
| `vitest` | 5.0.1 | required peer `vite ^6.4.0 \|\| ^7 \|\| ^8`; optional `jsdom`, `happy-dom`, `@types/node ^22 \|\| >=24`; engines `node ^22.12.0 \|\| ^24.0.0 \|\| >=26`. Published 2026-09-15T08:49Z (already in the repo's `minimumReleaseAgeExclude`) |
| `vite` | 8.3.0 | engines `node ^20.19.0 \|\| >=22.12.0` |
| `@vitejs/plugin-react` | 6.1.1 | peer `vite ^8.0.0` |
| `jsdom` | 30.0.1 | engines `node ^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` (CI must run Node >= 24.15.0) |
| `happy-dom` | 20.14.5 | engines `node >=20.0.0` |
| `@testing-library/react` | 16.3.3 | peers `react`/`react-dom` `^18 \|\| ^19`, `@testing-library/dom ^10.0.0` (install explicitly), optional `@types/react(-dom)` |
| `@testing-library/dom` | 10.4.2 | engines `node >=18` |
| `@testing-library/jest-dom` | 7.0.1 | peers `@testing-library/dom >=10 <11`, optional `vitest >=0.32`; engines `node >=22` |
| `@testing-library/user-event` | 14.6.7 | peer `@testing-library/dom >=7.21.4` |
| `@playwright/test` | 1.63.0 | engines `node >=20`; bundles Chrome for Testing 153.0.8010.12 (playwright chromium v1243) |
| `eslint` / `eslint-config-next` (only if linting) | 9.39.5 / 16.3.5 | `eslint-config-next` depends on `typescript-eslint ^8.46.0` (resolves 8.70.0, peer `typescript >=4.8.4 <6.1.0`) and `eslint-plugin-react 7.37.5` (peer `eslint ... ^9.7`). ESLint 10.10.0 is latest but breaks this config (see TS 7 verdict) |

In the scratch app with the full dependency set above (minus ESLint), `pnpm peers check` reported "No peer dependency issues found".

Release-age policy: pnpm 11+ defaults `minimumReleaseAge` to 1440 minutes (https://pnpm.io/settings/dependency-resolution). As of 2026-09-15T12:24Z, the only package in this list younger than 24 hours is `vitest@5.0.1` (and its `@vitest/*` packages), which the workspace already excludes. `lucide-react@1.46.0` became old enough at 2026-09-15T09:23Z.

### TypeScript 7 verdict (evidence)

**Next.js 16.3.5 builds and type-checks with TypeScript 7.0.2 with no extra configuration.**
- Source: `next/dist/server/config-shared.js` sets `experimental.useTypeScriptCli: true` by default, so `next build` spawns the project-local `tsc` (`tsc --project tsconfig.json --noEmit ...`) instead of `require('typescript')`. Config loading (`paths` aliases) uses `tsc --showConfig` in the same mode (`next/dist/build/load-jsconfig.js`).
- Docs: "Next.js uses the project-local `tsc` CLI by default, so no additional configuration is required. To use the JavaScript compiler API instead, set `experimental.useTypeScriptCli` to `false`." (https://nextjs.org/docs/app/api-reference/config/typescript#using-typescript-7). "If you opt out while using TypeScript 7, `next build` exits because the TypeScript JavaScript compiler API is unavailable." (https://nextjs.org/docs/app/api-reference/config/next-config-js/useTypeScriptCli)
- Experiment results (scratch app on Next 16.3.5, React 19.3.0, TS 7.0.2, strict):
  - `next build` passed.
  - Adding `const x: number = "not a number"` made the build fail with `app/bad.ts(1,14): error TS2322 ... Failed to type check.` (exit 1).
  - With `experimental.useTypeScriptCli: false`, the build failed with: "TypeScript 7.0.2 does not provide the compiler API required by Next.js. Set experimental.useTypeScriptCli back to true ... or install TypeScript 6 instead."
  - The same TS 7 check passed with the whole stack in place: shadcn Base UI components, react-resizable-panels, @dnd-kit/react, culori + @types/culori, `next/font/local`, `proxy.ts`, `typedRoutes: true`, Vitest test files using jest-dom matchers, and `playwright.config.ts`.
  - With `typedRoutes`, `<Link href="/aboot">` failed with `TS2769`.
  - Next's automatic `tsconfig` rewrite (it added `allowJs`, `skipLibCheck`, `esModuleInterop: true`) is accepted by TS 7.
  - `next dev` served pages, with `@/*` path aliases resolving under TS 7.
- Other tools in this topic:
  - Tailwind, the shadcn CLI (its own TS via ts-morph), Vitest/Vite (Oxc transform, no `typescript` import) and Playwright ran unchanged with TS 7 installed.
  - All their published `.d.ts` files type-check under `tsc` 7.0.2.
- **Needs TypeScript 6.x: `eslint-config-next` (via typescript-eslint).**
  - With TS 7 resolved, `eslint` throws `Error: typescript-eslint does not support TS 7.0.` The typescript-eslint 8.70.0 peer is `typescript >=4.8.4 <6.1.0`.
  - Verified workaround: put `eslint-config-next` in a separate workspace package whose own dependency is `typescript@6.0.3`, and have `apps/web` (TS 7) import that config. pnpm then resolves `typescript-eslint@8.70.0_..._typescript@6.0.3`, and `eslint app` ran and reported `@typescript-eslint/no-unused-vars`, `@next/next/no-img-element` and `jsx-a11y/alt-text`.
  - That setup also needs **ESLint 9.39.5**. With ESLint 10.10.0 it crashes: `contextOrFilename.getFilename is not a function` in `eslint-plugin-react@7.37.5`.
- The TypeScript team's own guidance for API-dependent tools is the npm alias `"typescript": "npm:@typescript/typescript6@^6.0.2"` alongside `"@typescript/native": "npm:typescript@^7.0.2"` (https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/).
  - Caveat from Next's source (`getTypeScriptPackageInfo`): with that alias, `typescript/package.json` resolves to TS 6 and Next picks its `tsc6` bin. `next build` would then type-check with TS 6, not 7. The separate lint-config package keeps TS 7 for the app.
- Editor: TS 7.0 "does not ship with an API" (same TS blog post), so the `{"name": "next"}` language-service plugin that Next writes into `tsconfig.json` very likely does not load under the TS 7 language server. Not verified in an editor.

## Verified APIs

### Next.js config and tsconfig (compiled with TS 7.0.2)

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false, // stop `next dev` writing AGENTS.md / CLAUDE.md into apps/web
  typedRoutes: true,
  // experimental.useTypeScriptCli: leave unset (default true); false breaks with TS 7
};

export default nextConfig;
```

- `agentRules`: in 16.3.5, `next dev` printed "Generated AGENTS.md and CLAUDE.md for AI agents. Set `agentRules: false` in next.config to disable." and wrote both files at the app root. With `agentRules: false` it wrote neither. The typing and doc comment are in `next/dist/server/config-shared.d.ts` ("When `next dev` detects an AI coding agent ... auto-generates `AGENTS.md` and `CLAUDE.md` ... @default true"). The docs URL for this option returned 404 on 2026-09-15.
- `typedRoutes` and `next.config.ts`: https://nextjs.org/docs/app/api-reference/config/typescript
- `next lint` was removed in Next 16 and `next build` does not lint: https://nextjs.org/docs/app/api-reference/config/eslint

Minimal `tsconfig.json` that Next accepted and then augmented. TS 7 hard-errors on `baseUrl`, `moduleResolution: node10`, `esModuleInterop: false` and `target: es5` (TS 7 blog post), so none of those appear.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "strict": true,
    "noEmit": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "allowJs": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

The CLI checker "checks the complete project selected by your `tsconfig` file. This includes test files and `.next/dev/types`" (https://nextjs.org/docs/app/api-reference/config/typescript#using-typescript-7). Test and E2E files therefore must type-check during `next build`, or they must be excluded through `typescript.tsconfigPath`.

### Tailwind CSS v4 with Next (PostCSS)

Source: https://tailwindcss.com/docs/installation/framework-guides/nextjs

```js
// postcss.config.mjs
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

```css
/* app/globals.css (as produced by shadcn init, trimmed) */
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

:root { --background: oklch(1 0 0); --foreground: oklch(0.145 0 0); --primary: oklch(0.205 0 0); /* ... */ }
.dark { --background: oklch(0.145 0 0); --foreground: oklch(0.985 0 0); /* ... */ }

@theme inline {
  --color-background: var(--background);
  --color-primary: var(--primary);
  --font-sans: var(--font-geist-sans);
}
```

- `@theme inline` is required when a theme variable references another variable. `--color-*` generates color utilities and `--font-*` generates font-family utilities (https://tailwindcss.com/docs/theme).
- Data-attribute dark mode, useful for themes: `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` (https://tailwindcss.com/docs/dark-mode).
- Browser floor: Chrome 111, Safari 16.4, Firefox 128. Tailwind v4 is not designed for Sass/Less/Stylus, and CSS Modules are discouraged (https://tailwindcss.com/docs/compatibility).
- No `tailwind.config.js` is needed. `components.json` has `"tailwind": { "config": "" }`.

### shadcn CLI 4.21.0 (Base UI default)

- `shadcn init --help` (4.21.0) lists `-t, --template` (next, start, vite, react-router, laravel, astro), `-b, --base` (base, radix, aria), `-p, --preset`, `--monorepo`/`--no-monorepo`, `--css-variables` (default true), `--rtl`, `--pointer`, `-y`. Other subcommands: `apply`, `add`, `docs`, `view`, `search`, `migrate`, `eject` ("inline shadcn/tailwind.css and remove the shadcn dependency"), `info`, `build` and `mcp`.
- Valid presets (from the CLI's error text): nova, vega, maia, lyra, mira, luma, sera, rhea. The help text describes `-d` as `--template=next --preset=base-nova`, but passing `-p base-nova` explicitly failed with "Invalid preset: base-nova". The base is chosen separately with `-b`. `-d` itself was not run.
- "New projects default to Base UI ... To opt for Radix in new projects, use the flag: `pnpm dlx shadcn init -b radix`". "Radix is not being deprecated." (https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default)
- `init` installs the `cn` package and generates a `lib/utils.ts` that re-exports it (https://ui.shadcn.com/docs/changelog/2026-09-cn).
- CLI reference: https://ui.shadcn.com/docs/cli. Next guide: https://ui.shadcn.com/docs/installation/next (requires the `@/*` alias in `tsconfig.json`).

Verified run in an existing Next 16 + Tailwind 4 app (non-interactive; without `-p` the command waits on a prompt):

```bash
pnpm dlx shadcn@4.21.0 init -b base -p nova --no-monorepo -y
pnpm dlx shadcn@4.21.0 add button resizable dropdown-menu dialog sidebar sonner -y
```

Result:
- Preflight output: "Found Next.js", "Found v4".
- `components.json` contains `"style": "base-nova"`, `"rsc": true`, `"iconLibrary": "lucide"`, `"baseColor": "neutral"`, `"cssVariables": true`, and aliases `@/components`, `@/lib/utils`, `@/components/ui`, `@/lib`, `@/hooks`.
- Dependencies added: `@base-ui/react ^1.8.0`, `class-variance-authority`, `cn ^0.3.0`, `lucide-react ^1.46.0`, `shadcn ^4.21.0`, `tw-animate-css`, then `react-resizable-panels ^4.12.4`, `next-themes`, `sonner`.
- `init` also rewrote `app/layout.tsx` to load Geist via `next/font/google` (replace it with the local fonts below).
- `lib/utils.ts` is `export { cn } from "cn"`.

Generated Base UI dialog, excerpt (the composition uses a `render` prop, not Radix's `asChild`):

```tsx
"use client"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}
// usage (compiled and tested):
// <DialogTrigger render={<Button>Open</Button>} />
```

Base UI setup notes (https://base-ui.com/react/overview/quick-start):
- Package `@base-ui/react` with per-feature imports (`@base-ui/react/dialog`).
- Add `.root { isolation: isolate; }` on the app root for portals.
- Add `body { position: relative; }` for iOS 26+ Safari.

### Icons: lucide-react 1.46.0

```tsx
import { XIcon } from "lucide-react"; // named import, tree-shakable; aria-hidden by default in v1
```

- Source: https://lucide.dev/guide/packages/lucide-react
- v1 removed brand icons (GitHub, Slack, etc.), dropped the UMD build, and made `aria-hidden` the default: https://lucide.dev/guide/version-1
- Icons that carry meaning need a visible label or `aria-label` on the parent control.

### Fonts: `next/font/local` over Fontsource files (this exact file compiled; woff2 emitted to `.next/static/media`)

`src` paths are "relative to the directory where the font loader function is called"; `weight` accepts a range string for variable fonts; the other options are `variable`, `display` (default `'swap'`), `preload` (default `true`), `fallback`, `adjustFontFallback` (`'Arial'` default, `'Times New Roman'`, or `false`) and `declarations` (https://nextjs.org/docs/app/api-reference/components/font).

```ts
// app/fonts.ts (paths into apps/web/node_modules resolved through pnpm symlinks in the experiment)
import localFont from "next/font/local";

export const geist = localFont({
  src: [
    { path: "../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2", weight: "100 900", style: "normal" },
    { path: "../node_modules/@fontsource-variable/geist/files/geist-latin-wght-italic.woff2", weight: "100 900", style: "italic" },
  ],
  variable: "--font-geist",
  display: "swap",
});

export const fraunces = localFont({
  src: "../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2",
  weight: "100 900",
  variable: "--font-fraunces",
  display: "swap",
  preload: false, // non-default theme font
  adjustFontFallback: "Times New Roman",
});

export const plexMono = localFont({
  src: [
    { path: "../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
});
```

```tsx
// app/layout.tsx
<html lang="en" className={cn(geist.variable, fraunces.variable, plexMono.variable)}>
```

```css
@theme inline { --font-sans: var(--font-geist); --font-serif: var(--font-fraunces); --font-mono: var(--font-plex-mono); }
```

Files verified to exist in 5.3.0 (latin subset `*-latin-wght-{normal,italic}.woff2`), with axes and weight ranges from each package's `metadata.json`:

| family | package | axes | wght |
| --- | --- | --- | --- |
| Geist | `@fontsource-variable/geist` | ital, wght | 100 to 900 |
| Geist Mono | `@fontsource-variable/geist-mono` | ital, wght | 100 to 900 |
| Source Sans 3 | `@fontsource-variable/source-sans-3` | ital, wght | 200 to 900 |
| Source Serif 4 | `@fontsource-variable/source-serif-4` | ital, opsz, wght | 200 to 900 |
| Nunito | `@fontsource-variable/nunito` | ital, wght | 200 to 1000 |
| Public Sans | `@fontsource-variable/public-sans` | ital, wght | 100 to 900 |
| DM Sans | `@fontsource-variable/dm-sans` | ital, opsz, wght | 100 to 1000 |
| Fraunces | `@fontsource-variable/fraunces` | ital, opsz, wght, SOFT, WONK | 100 to 900 |
| Manrope | `@fontsource-variable/manrope` | wght (no italic) | 200 to 800 |
| IBM Plex Mono | `@fontsource/ibm-plex-mono` | static | 100 to 700, normal and italic |

- Licenses: every package above is OFL-1.1 by npm metadata, and its bundled `LICENSE` file is the SIL Open Font License 1.1. Geist is "Copyright 2024 The Geist Project Authors", and the `geist` npm package LICENSE is also OFL 1.1.
- Alternative without `next/font`: import the CSS directly (`import "@fontsource-variable/nunito"` or `/wght.css`, `/opsz.css`, `/full.css`). Font family names then carry a " Variable" suffix (https://fontsource.org/docs/getting-started/variable). This keeps all unicode-range subsets but loses `next/font`'s size-adjusted fallback and preloading.

### Resizable and collapsible panels: react-resizable-panels 4.12.4

- API from the published `.d.ts` and the README (https://github.com/bvaughn/react-resizable-panels):
  - `Group` props: `orientation`, `id`, `defaultLayout` (a `Layout`, which is `{ [panelId]: number }`), `onLayoutChange`, `onLayoutChanged(layout, { isUserInteraction })`, `groupRef`, `disabled`.
  - `Panel` props: `id`, `defaultSize`/`minSize`/`maxSize`/`collapsedSize`, `collapsible`, `panelRef`, `onResize`, `groupResizeBehavior`.
  - Sizes: numbers are pixels. Strings without units are percentages. Explicit units `px`, `%`, `em`, `rem`, `vh`, `vw` are allowed.
  - `PanelImperativeHandle`: `collapse()`, `expand()`, `isCollapsed()`, `getSize() => { asPercentage, inPixels }`, `resize(size: number | string)`.
  - Hooks: `usePanelRef()`, `useGroupRef()`, `useDefaultLayout(...)`.

SSR-safe persistence via a cookie. This mirrors the library's own `integrations/next` example (a client `Group` wrapper writing `document.cookie`, and a Server Component reading `cookies()`); compiled and built:

```tsx
// app/t/[id]/persisted-group.tsx
"use client";
import { Group, type GroupProps } from "react-resizable-panels";

export function PersistedGroup(props: Omit<GroupProps, "onLayoutChanged">) {
  return (
    <Group
      {...props}
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return;
        document.cookie = `panels:${props.id}=${encodeURIComponent(JSON.stringify(layout))}; path=/; max-age=31536000; samesite=lax`;
      }}
    />
  );
}
```

```tsx
// app/t/[id]/page.tsx (Server Component; Panel and Separator import fine on the server)
import { cookies } from "next/headers";
import { Panel, Separator, type Layout } from "react-resizable-panels";
import { PersistedGroup } from "./persisted-group";

async function readLayout(id: string): Promise<Layout | undefined> {
  const raw = (await cookies()).get(`panels:${id}`)?.value;
  if (!raw) return undefined;
  try { return JSON.parse(decodeURIComponent(raw)) as Layout; } catch { return undefined; }
}

export default async function Page() {
  return (
    <PersistedGroup id="task" orientation="horizontal" defaultLayout={await readLayout("task")}>
      <Panel id="page" minSize="30%">Markdown page</Panel>
      <Separator />
      <Panel id="chat" collapsible collapsedSize={0} minSize={280} defaultSize="35%">Simon</Panel>
    </PersistedGroup>
  );
}
```

Collapse toggle (compiled; ran in Playwright):

```tsx
const chat = usePanelRef();
<ResizablePanel id="chat" panelRef={chat} collapsible collapsedSize={0} defaultSize="40%" minSize="20%" />
<Button onClick={() => (chat.current?.isCollapsed() ? chat.current?.expand() : chat.current?.collapse())} />
```

- `cookies()` is async, readable in Server Components, and settable only in Server Functions or Route Handlers (https://nextjs.org/docs/app/api-reference/functions/cookies).
- The shadcn `resizable` component (Base UI style) wraps `Group`/`Panel`/`Separator` as `ResizablePanelGroup`/`ResizablePanel`/`ResizableHandle withHandle`.

### Drag and drop: @dnd-kit/react 0.5.0 (sortable list plus drop target, keyboard and screen reader)

- "`@dnd-kit/react` is the only required package. For sortable lists, you'll also want `@dnd-kit/helpers`" (https://dndkit.com/react/quickstart).
- The legacy docs say: "There's a new version of @dnd-kit available. We recommend you use the latest version instead." (https://dndkit.com/legacy/introduction/installation)
- `useSortable` input: `id`, `index`, `group`, `type`, `accept`, `handle`, `transition`, `modifiers`, `sensors`, `disabled`. Output: `ref`, `handleRef`, `targetRef`, `isDragging`, `isDragSource`, `isDropTarget`, `isDropping` (https://dndkit.com/react/hooks/use-sortable, confirmed in `sortable.d.ts`).
- `defaultPreset` in `@dnd-kit/dom@0.5.0`:
  - plugins: `[Accessibility, AutoScroller, Cursor, Feedback, PreventSelection]`
  - sensors: `[PointerSensor, KeyboardSensor]`
- Keyboard codes: start `Space`/`Enter`, cancel `Escape`, end `Space`/`Enter`/`Tab`, move with the arrow keys.
- The Accessibility plugin is on by default and manages ARIA attributes and a live region (https://dndkit.com/extend/plugins/accessibility).

Compiled with TS 7; unit-rendered in happy-dom; keyboard reorder (Space, ArrowDown, Space) passed in Playwright Chromium:

```tsx
"use client";
import { useState } from "react";
import { DragDropProvider, useDroppable } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { move } from "@dnd-kit/helpers";
import { Accessibility, type DragStartEvent, type DragEndEvent } from "@dnd-kit/dom";

function Row({ id, index }: { id: string; index: number }) {
  const { ref, handleRef, isDragSource } = useSortable({ id, index, group: "tasks", type: "task", accept: "task" });
  return <li ref={ref} aria-hidden={isDragSource}><button ref={handleRef} aria-label={`Reorder ${id}`}>::</button>{id}</li>;
}

function Trash() {
  const { ref, isDropTarget } = useDroppable({ id: "trash", accept: "task" });
  return <div ref={ref} data-over={isDropTarget}>Trash</div>;
}

export function TaskList() {
  const [items, setItems] = useState(["a", "b", "c"]);
  return (
    <DragDropProvider
      plugins={(defaults) => [...defaults, Accessibility.configure({ announcements: {
        // configure() options are typed `any` in 0.5.0: annotate the events explicitly
        dragstart: (event: DragStartEvent) => event.operation.source ? `Picked up ${event.operation.source.id}` : undefined,
        dragend: (event: DragEndEvent) => event.canceled ? "Cancelled" : `Dropped ${event.operation.source?.id} on ${event.operation.target?.id ?? "nothing"}`,
      } })]}
      onDragOver={(event) => setItems((current) => move(current, event))}
      onDragEnd={(event) => {
        if (event.canceled) return;
        if (event.operation.target?.id === "trash") setItems((c) => c.filter((i) => i !== event.operation.source?.id));
      }}
    >
      <ul>{items.map((id, index) => <Row key={id} id={id} index={index} />)}</ul>
      <Trash />
    </DragDropProvider>
  );
}
```

Details:
- `plugins` accepts a value or a function `(defaults) => ...` (`Customizable<T> = T | ((defaults: T) => T)` in `@dnd-kit/abstract`).
- In 0.5.0 `announcements.dragstart` and `.dragend` are required keys (`dragmove` and `dragover` are optional).

Tree:
- There is no packaged tree component. The official React tree story is `apps/stories/stories/react/Sortable/Tree` in https://github.com/clauderic/dnd-kit.
- It flattens the tree (`flattenTree`/`buildTree`), and each row is `useSortable({ id, index, data: { depth, parentId }, alignment: { x: "start", y: "center" } })`.
- Depth is projected from the horizontal drag offset in `onDragOver`/`onDragMove` (`manager.dragOperation.transform.x`).
- For keyboard use, horizontal arrow keys change depth: it calls `isKeyboardEvent` from `@dnd-kit/dom/utilities` and `event.preventDefault()` on horizontal moves.
- The story is on `main`, so check it against 0.5.0 when porting.

### OKLCH accent derivation and WCAG contrast: culori 4.0.2

Functions (https://culorijs.org/api/):
- `converter(mode)` and `parse`
- `formatHex`, `formatCss`
- `wcagContrast(a, b)`: "contrast ratio ... per WCAG 2.0"
- `wcagLuminance`
- `clampChroma(color, mode = 'lch', rgbGamut = 'rgb')`
- `toGamut(dest = 'rgb', mode = 'oklch', ...)`
- `displayable`, `inGamut(mode)`
- a tree-shakeable `culori/fn` entry with `useMode(modeOklch)`

```ts
// lib/accent.ts (compiled with @types/culori under TS 7; asserted in Vitest)
import { converter, formatHex, formatCss, wcagContrast, clampChroma, displayable, type Oklch } from "culori";

const toOklch = converter("oklch");

export function deriveAccent(input: string, surface = "#ffffff") {
  const base = toOklch(input);
  if (!base) throw new Error("invalid color");
  let fg: Oklch = { mode: "oklch", l: base.l, c: base.c, h: base.h ?? 0 };
  while (wcagContrast(fg, surface) < 4.5 && fg.l > 0) fg = { ...fg, l: fg.l - 0.01 };
  const safe = clampChroma(fg, "oklch");
  return { css: formatCss(safe), hex: formatHex(safe), contrast: wcagContrast(safe, surface), inSrgb: displayable(safe) };
}
```

Run output on Node 24: `oklch(0.72 0.19 150)` starts at contrast 2.30 against `#fff`, then darkens to `oklch(0.54 0.1487 150)` = `#00853c` at 4.73.

### Unit tests: Vitest 5 + React Testing Library (3 tests passed: jsdom and happy-dom)

Next's guide installs `vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/dom vite-tsconfig-paths` and sets `test.environment: 'jsdom'`. It notes Vitest does not support async Server Components; test those with E2E instead (https://nextjs.org/docs/app/guides/testing/vitest). Vite 8 has a native `resolve.tsconfigPaths` boolean (default `false`) that replaces the `vite-tsconfig-paths` plugin (https://vite.dev/config/shared-options).

```ts
// vitest.config.mts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
  },
});
```

```ts
// vitest.setup.ts
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(() => cleanup());
```

```tsx
// __tests__/dialog.test.tsx
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

test("base ui dialog opens", async () => {
  const user = userEvent.setup();
  render(<Dialog><DialogTrigger render={<Button>Open</Button>} /><DialogContent><DialogTitle>Task settings</DialogTitle></DialogContent></Dialog>);
  await user.click(screen.getByRole("button", { name: "Open" }));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});
```

- Per-file environment override: a `// @vitest-environment happy-dom` docblock. In Vitest 5, "browser" is not an environment; use Browser Mode instead (https://vitest.dev/guide/environment).
- jest-dom for Vitest: `import '@testing-library/jest-dom/vitest'` in a `.ts` setup file (https://github.com/testing-library/jest-dom).

### E2E: Playwright 1.63.0 (1 test passed in Chromium against `next start`)

Next recommends testing the production build (`build` then `start`) and suggests Playwright's `webServer` option (https://nextjs.org/docs/app/guides/testing/playwright). `webServer` reference: https://playwright.dev/docs/test-webserver

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:3000" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec next start -p 3000",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
```

The browser install command was `npx playwright install --only-shell chromium` (with `PLAYWRIGHT_BROWSERS_PATH` pointed at the scratch dir); `pnpm exec playwright install ...` is the workspace equivalent. On CI, run `playwright install-deps` as well (Next guide above). The experiment used port 3123; the snippet uses 3000.

### Talking to the NestJS API on another subdomain

Facts:
- A cookie without `Domain` is host-only. "When specified: the cookie is available to that domain and all its subdomains." (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
- `SameSite=Lax` sends the cookie on same-site requests. `SameSite=None` requires `Secure`.
- A `__Host-` cookie must be `Secure`, `Path=/`, and must **not** have `Domain`.
- A site is the registrable domain (eTLD+1, schemeful for SameSite), so `app.example.com` and `api.example.com` are same-site. Entries on the Public Suffix List make each subdomain its own site (https://developer.mozilla.org/en-US/docs/Glossary/Site).
- The current Public Suffix List (https://publicsuffix.org/list/public_suffix_list.dat) includes both `vercel.app` and `onrender.com`. Default Vercel and Render hostnames are therefore always cross-site to each other.
- Cross-origin `fetch` sends no credentials by default; use `credentials: "include"`. For credentialed responses, `Access-Control-Allow-Origin` (and `Allow-Headers`, `Allow-Methods`, `Expose-Headers`) must not be `*`, and the server must send `Access-Control-Allow-Credentials: true`. "Third-party cookie policies will still apply." (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)

Browser to API (client components); compiled:

```ts
export function apiFetchClient(path: string, init: RequestInit = {}) {
  return fetch(new URL(path, process.env.NEXT_PUBLIC_API_ORIGIN), { ...init, credentials: "include" });
}
```

NestJS side. Taken from the docs and not compiled here: NestJS is outside this topic, and the backend research owns it. Sources: https://docs.nestjs.com/security/cors and the `cors` options at https://github.com/expressjs/cors, where `origin` accepts a string, RegExp, array or function, and `credentials: true` sets `Access-Control-Allow-Credentials`.

```ts
const app = await NestFactory.create(AppModule);
app.enableCors({ origin: ["https://app.example.com"], credentials: true });
// Session cookie set by the API, e.g.:
// Set-Cookie: __Secure-symplist_session=<opaque>; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=Lax
```

Next `proxy.ts` (formerly `middleware.ts`) can read an API-set cookie **only if the API scoped it to the parent domain** (`Domain=example.com`). A host-only or `__Host-` cookie set by `api.example.com` is never sent to `app.example.com`.

Proxy docs (https://nextjs.org/docs/app/api-reference/file-conventions/proxy):
- `middleware` was "deprecated and renamed to proxy" in v16.0.0.
- Proxy "defaults to using the Node.js runtime", and `runtime` config throws.
- `request.cookies` has `get`, `getAll`, `has`, `set`, `delete`, `clear`.
- The auth guide says Proxy should "only read the session from the cookie (optimistic checks), and avoid database checks", and "should not be your only line of defense" (https://nextjs.org/docs/app/guides/authentication).

Compiled and built (the build reported `ƒ Proxy (Middleware)`):

```ts
// proxy.ts
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "__Secure-symplist_session"; // presence check only; the API validates

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isAppRoute = pathname.startsWith("/t/") || pathname === "/inbox";
  if (isAppRoute && !request.cookies.has(SESSION_COOKIE)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
```

Server Components and Route Handlers calling the API must forward cookies explicitly; the server-side `fetch` has no browser cookie jar. Compiled:

```ts
import { cookies } from "next/headers";

export async function apiFetchServer(path: string, init: RequestInit = {}) {
  const cookieStore = await cookies();
  const headers = new Headers(init.headers);
  headers.set("cookie", cookieStore.toString());
  return fetch(new URL(path, process.env.API_ORIGIN), { ...init, headers, cache: "no-store" });
}
```

A `Set-Cookie` returned to that server-side fetch does not reach the browser, and Server Components cannot set cookies (https://nextjs.org/docs/app/api-reference/functions/cookies). Login, refresh and logout must therefore be browser-to-API requests, so the API's `Set-Cookie` lands directly in the browser.

Considered alternative: same-origin proxying through a rewrite (`/api/:path*` to `https://api.example.com/:path*`). Vercel supports external rewrites as a reverse proxy. For projects created on or after 2026-04-06 it honors upstream `Cache-Control`/`CDN-Cache-Control` on those rewrites by default, and `x-vercel-enable-rewrite-caching: 0` opts out (https://vercel.com/docs/rewrites). Not chosen; see decisions.

## Decisions and recommendations

1. **Versions.** Pin exact versions in `apps/web`: `next` 16.3.5, `react`/`react-dom` 19.3.0, `@types/react`/`@types/react-dom` 19.3.0, `@types/node` 24.13.4, `typescript` 7.0.2.
2. **TypeScript 7 in the web app.** Use TS 7.0.2 and leave `experimental.useTypeScriptCli` unset (default `true`). Keep the workspace `typecheck` script as `tsc --noEmit` for CI. Remember that `next build` type-checks the whole `tsconfig` project, including tests and E2E files. Remove `baseUrl` from any shared tsconfig, because it is a TS 7 hard error.
3. **Agent files.** Set `agentRules: false` in `next.config.ts`, so `next dev` does not create `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` alongside the repo's own agent docs.
4. **Tailwind.** Use Tailwind CSS 4.3.3 through `@tailwindcss/postcss` 4.3.3 (plus `postcss` 8.5.28). Keep the config CSS-first with no JS config. Define theme tokens as `oklch()` CSS variables in `:root`/`.dark` (or `[data-theme]`) and map them with `@theme inline`.
5. **shadcn with Base UI.** Use shadcn CLI 4.21.0 with the Base UI base: create `apps/web` with Next first, then run `shadcn init -b base -p <preset> --no-monorepo -y` inside it. Base UI (`@base-ui/react` 1.8.0) is the shadcn default since 2026-07, stable 1.x, and every new component ships for both bases. Radix remains a one-flag fallback (`-b radix`). Replace the `next/font/google` layout edit that `init` makes with the local font setup. After components settle, consider `shadcn eject` so the CLI package (MCP SDK, ts-morph, Babel) is not a runtime dependency.
6. **Icons.** Use `lucide-react` 1.46.0 (shadcn's `iconLibrary`). Brand marks such as GitHub or Slack for integrations must come from our own SVGs, because Lucide v1 removed brand icons.
7. **Panels.** Use `react-resizable-panels` 4.12.4 through the shadcn `resizable` wrapper. Persist layouts in a first-party cookie on the app host, read it in a Server Component and pass it as `defaultLayout`. Do not use `useDefaultLayout` with its default storage in SSR-rendered components. Use `collapsible` + `panelRef` for the chat and sidebar toggles.
8. **Drag and drop.** Use `@dnd-kit/react` + `@dnd-kit/dom` + `@dnd-kit/helpers` 0.5.0, pinned exactly because they are pre-1.0, for the sortable task tree and drop targets. Build the tree on the official flattened-tree story, and keep the default Accessibility and Keyboard plugins with Symplist-specific announcements. Do not adopt legacy `@dnd-kit/core` 6.3.1 / `@dnd-kit/sortable` 10.0.0, which had no releases since 2024-12 and which the dnd-kit docs point away from. Render the tree with real `role="tree"`/`treeitem` semantics ourselves; neither dnd-kit nor Base UI ships a tree view.
9. **Accent colors.** Use `culori` 4.0.2 + `@types/culori` 4.0.1. Accept a user accent, convert it to OKLCH, and step lightness until `wcagContrast` is at least 4.5 against the theme's surface (and at least 3 for large text and UI borders). Then `clampChroma` into sRGB and emit `oklch()` tokens for light and dark separately. Unit-test every shipped accent and theme pair in Vitest. `colorjs.io` 0.7.1 also works, but culori is smaller, tree-shakeable (`culori/fn`) and typed.
10. **Fonts.**
    - Self-host with `next/font/local` pointing at `@fontsource-variable/*` 5.3.0 (Geist, Geist Mono, Source Sans 3, Source Serif 4, Nunito, Public Sans, DM Sans, Fraunces, Manrope) and `@fontsource/ibm-plex-mono` 5.3.0 (static 400/500/600/700).
    - Keep one `app/fonts.ts`; use the latin `*-wght-*` files and a CSS variable per family.
    - Set `preload: true` only for the default theme's sans and mono, and `preload: false` for alternates.
    - Prefer these over `next/font/google`, which fetches from Google at build time, and over the `geist` package, for uniformity; `geist` 1.7.2 also works.
    - Ship the OFL-1.1 text with the fonts, for example a `THIRD_PARTY_NOTICES` entry listing each family and copyright holder.
11. **Unit tests.** Use `vitest` 5.0.1 + `vite` 8.3.0 + `@vitejs/plugin-react` 6.1.1, with `resolve.tsconfigPaths: true` instead of `vite-tsconfig-paths`. Default the environment to `jsdom` 30.0.1, and opt into `happy-dom` 20.14.5 per file only where speed matters. Add `@testing-library/react` 16.3.3 + `@testing-library/dom` 10.4.2 + `@testing-library/jest-dom` 7.0.1 + `@testing-library/user-event` 14.6.7.
12. **E2E tests.** Run `@playwright/test` 1.63.0 against `next build` + `next start` via `webServer`, with Chromium in CI to start with. Cover keyboard drag and drop, panel collapse, and the auth redirect in Playwright rather than jsdom.
13. **Linting.** Optional for beta. If added, put `eslint` 9.39.5 + `eslint-config-next` 16.3.5 (core-web-vitals + typescript) in a dedicated workspace package that depends on `typescript` 6.0.3, and import it from `apps/web`; this keeps TS 7 for `tsc`/`next build`. Do not use ESLint 10 with this config yet.
14. **Domains and cookies.**
    - Serve the web app and API from the same registrable domain on custom domains, for example `app.<domain>` (Vercel) and `api.<domain>` (Render). Never rely on `*.vercel.app` or `*.onrender.com` for authenticated flows.
    - The API sets the session cookie `__Secure-` prefixed with `Domain=<domain>; Path=/; Secure; HttpOnly; SameSite=Lax`, so both the browser's API calls and the Next server/proxy receive it.
    - The API enables credentialed CORS for the exact app origin(s) only.
    - Browser code uses `credentials: "include"`, and server code forwards `cookies().toString()`.
    - `proxy.ts` does presence-only redirects; the API (and a server-side `/me` call where needed) is the authority.
    - Login, logout and refresh happen browser-to-API.
    - WebSockets connect directly to `wss://api.<domain>`; the cookie rides the handshake because the domain matches. The gateway must check `Origin` itself, because CORS does not apply to WebSocket upgrades (RFC 6455 section 10.2, https://www.rfc-editor.org/rfc/rfc6455#section-10.2).
15. **No same-origin rewrite.** Do not proxy the API through Vercel rewrites for beta. It adds a hop, puts API responses under Vercel CDN cache rules, and does not help the direct WebSocket connection to Render.

## Risks and open questions

- **`useTypeScriptCli` is marked experimental.** Its docs page carries the "experimental ... not recommended for production" banner even though it is the default. Behavior could change in a patch release. Its diagnostics are raw `tsc` output without Next-specific code frames. Mitigation: exact `next` pin, and CI also runs `tsc --noEmit`.
- **Next TS editor plugin under TS 7.** The `next` language-service plugin (client-hook and `'use client'` misuse warnings, segment-config hints) probably does nothing under the TS 7 language server, because 7.0 has no API. Not verified in an editor. TS 7.1 is expected to ship a new API (TS blog), and Next may change defaults again.
- **ESLint vs TS 7.** typescript-eslint throws on TS 7. The two-TypeScript setup (TS 6.0.3 inside a lint-config package) was verified, but it is extra machinery. `eslint-plugin-react` 7.37.5 does not support ESLint 10.
- **@dnd-kit/react is 0.5.0.** It is pre-1.0 and the repo `main` branch is ahead of the release. `Accessibility.configure` options are untyped (`any`), so handlers need explicit event types. The tree must be hand-built (projection, collapse, aria-level), and screen-reader wording and focus management need manual QA (VoiceOver and NVDA).
- **react-resizable-panels.** `useDefaultLayout` defaults `storage` to `localStorage` at call time. Rendering it in an SSR'd client component returned HTTP 500 (`ReferenceError: localStorage is not defined`) under `next start`. Use the cookie pattern. The README warns that percentage-based default sizes can cause slight layout shift on SSR; prefer pixel `minSize` for the chat and sidebar panels.
- **shadcn churn.**
  - The Base UI default (2026-07) and the `cn` package (0.3.0, 2026-09-12) are recent.
  - Community snippets written for Radix use `asChild`, while Base UI uses `render`.
  - `shadcn add` can overwrite local edits (`-o`).
  - `init` added the `shadcn` package as a runtime dependency and switched the layout to `next/font/google`; both need follow-up.
  - The help text's `base-nova` preset name is rejected by `-p`; use `-b base -p nova`.
- **Fonts.**
  - Latin-only subsets mean Cyrillic, Greek, Vietnamese and CJK text falls back to system fonts. Using `latin-ext` too without `unicode-range` would download both files; `declarations` can add descriptors.
  - Nine families with italics is a lot of CSS `@font-face`. Keep `preload` minimal.
  - `next/font/local` paths into `node_modules` worked with pnpm symlinks in the scratch app. Confirm this inside the real workspace (`apps/web/node_modules`) and on Vercel; vendoring the woff2 files into `apps/web/app/fonts/` with their OFL text is the fallback.
  - Manrope has no italic.
- **OFL obligations.** OFL 1.1 condition 2 (in each package's `LICENSE`) allows redistribution "provided that each copy contains the above copyright notice and this license", as stand-alone text or as viewable metadata. It also forbids selling the fonts by themselves (condition 1). Modified versions may not use Reserved Font Names (condition 3); we do not modify the fonts. Serving them from our origin counts as redistribution, so ship the license texts.
- **Cookie scope.** `Domain=<domain>` exposes the session cookie to every subdomain of the registrable domain, and any subdomain counts as same-site, which weakens SameSite as CSRF protection. Keep all subdomains first-party. Add Origin-header allowlisting (and ideally a custom request header that forces preflight) on state-changing API routes and on WebSocket upgrades.
- **Preview deployments.** Vercel previews on `*.vercel.app` are cross-site to the API and outside the cookie domain, so authenticated flows will not work there. Open: use a custom preview domain such as `preview.<domain>` pointing at a staging API, or skip auth in previews.
- **Node floor.** `jsdom` 30.0.1 requires Node `^24.15.0` on Node 24. CI and any local runner must be at least 24.15.0, which matches the repo's `engines`.
- **React versions.** React 19.3.0 is 6 days old. Next renders the App Router with its vendored React canary (`19.3.0-canary-cbb046ab-20260731`), while Vitest renders with the installed `react@19.3.0`. Behavior differences between the two are possible but unobserved.
- **Tailwind browser floor.** Tailwind v4 needs Safari 16.4, Chrome 111 or Firefox 128. Confirm this is acceptable for the closed beta.
- **Scratch pnpm version.** The experiments used pnpm 11.1.2, not the repo's 12.4.2. The resolution behaviors relied on (peer resolution per dependent, symlinked `node_modules`, `minimumReleaseAge`) are the same, but the real install in `apps/web` should re-run `pnpm peers check`.
- **Open questions.**
  - Final domain names.
  - Whether ESLint is in scope for beta, or whether `tsc` + Vitest + Playwright is enough.
  - Which theme's fonts are preloaded by default.
  - Whether to `shadcn eject` once the component set is stable.
