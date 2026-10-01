// Builds apps/web as a Next standalone server and stages it, with its static assets, into build/web —
// the directory electron-builder ships as the app's `web` resource and `src/main/next-server.ts` boots.
//
// Next's standalone output deliberately excludes `.next/static` and `public`, because a normal
// deployment serves them from a CDN. This app is its own CDN, so they are copied in here.
//
// Usage: node scripts/stage-web.mjs    (pnpm --filter @symplist/desktop build:web)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = join(appDir, "..", "..");
const webDir = join(repoRoot, "apps", "web");
const stageDir = join(appDir, "build", "web");

function run(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file} exited with ${signal ?? code}`));
    });
  });
}

/**
 * Copies a tree, recreating every symlink with the exact target string it already had.
 *
 * `fs.cp` cannot be used for the standalone tree, and the reason is specific. Under pnpm the tree is
 * mostly symlinks: `apps/web/node_modules/next` points at `../../../node_modules/.pnpm/next@<hash>/…`,
 * relative, so the whole tree is self-contained and can be moved anywhere. `fs.cp` preserves symlinks
 * but resolves each target against the *source* directory and writes it back absolute, so the staged
 * copy ends up pointing into apps/web/.next/standalone on this machine. That works until the web app is
 * rebuilt and can never work inside a .dmg on someone else's disk — and it fails at boot, not at build.
 *
 * Dereferencing instead is not the fix either: it turns `next` into a real directory but leaves its
 * siblings behind in `.pnpm`, and the server then dies on `@swc/helpers`. Keeping the links exactly as
 * pnpm wrote them is what keeps the tree both self-contained and relocatable.
 */
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isSymbolicLink()) await symlink(await readlink(source), target);
    else if (entry.isDirectory()) await copyTree(source, target);
    else await cp(source, target);
  }
}

const require = createRequire(join(webDir, "package.json"));
const nextBin = require.resolve("next/dist/bin/next");

// SYMPLIST_DESKTOP=1 turns on `output: "standalone"` in apps/web/next.config.ts.
//
// NEXT_PUBLIC_WS_URL is blanked deliberately, and it is not a detail. `realtimeUrl()` returns null
// without it, which switches every live-update subscription in the frontend off. That is the correct
// desktop behaviour rather than a limitation: the renderer is served from 127.0.0.1 and holds no session
// cookie, so a socket opened from here is refused by the api's origin check on the upgrade before it is
// even looked at — it would retry forever and never connect. Main owns every authenticated connection in
// this app. An environment variable that happens to be set in apps/web/.env must not quietly undo that,
// so it is overridden here rather than left to whatever the build machine has.
await run(process.execPath, [nextBin, "build", "--webpack"], {
  cwd: webDir,
  env: { ...process.env, SYMPLIST_DESKTOP: "1", NEXT_PUBLIC_WS_URL: "" },
});

const standalone = join(webDir, ".next", "standalone");
if (!existsSync(standalone)) {
  throw new Error(`${standalone} is missing: the web build did not emit standalone output`);
}

await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });
await copyTree(standalone, stageDir);

// The standalone tree mirrors the workspace, so apps/web is where the server and its .next live.
const stagedWeb = existsSync(join(stageDir, "apps", "web"))
  ? join(stageDir, "apps", "web")
  : stageDir;
await cp(join(webDir, ".next", "static"), join(stagedWeb, ".next", "static"), { recursive: true });
await cp(join(webDir, "public"), join(stagedWeb, "public"), { recursive: true });

// Symlinks are expected here — pnpm's layout is made of them — so what is checked is that every one of
// them still lands inside build/web. A link that escapes resolves to this machine's source tree and
// would fail only once the app is installed somewhere else, which is far too late to find out. The
// staged tree is also the thing electron-builder copies verbatim, so this is the last place to look.
const escaped = [];
for (const entry of await readdir(stageDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isSymbolicLink()) continue;
  const link = join(entry.parentPath, entry.name);
  const resolved = resolve(entry.parentPath, await readlink(link));
  if (resolved !== stageDir && !resolved.startsWith(stageDir + sep)) {
    escaped.push(`${relative(stageDir, link)} -> ${resolved}`);
  }
}
if (escaped.length > 0) {
  const shown = escaped.slice(0, 5).join("\n  ");
  throw new Error(
    `${escaped.length} staged symlink(s) point outside build/web, so the app is not relocatable:\n  ${shown}`,
  );
}

// The public site is not part of the app.
//
// `apps/web` serves one Next app: the workspace *and* the marketing homepage, the legal pages and the
// crawler files. A desktop shell has no use for any of the second group — someone running the .dmg has
// already arrived — and shipping them means the installed app carries a copy of the website, which can
// drift from the deployed one and is pure weight in the bundle. The window opens `/now`, so these are
// unreachable as well as unwanted; they are removed from the staged copy rather than from `apps/web`,
// which still has to serve them to the web.
const publicSiteArtifacts = [
  "page.js",
  "page.js.nft.json",
  "page_client-reference-manifest.js",
  "page.meta",
  "page.rsc",
  "page.segments",
  "page.html",
  "terms",
  "privacy",
  "cookies",
  "robots.txt",
  "robots.txt.body",
  "robots.txt.meta",
  "sitemap.xml",
  "sitemap.xml.body",
  "sitemap.xml.meta",
  "llms.txt",
];
const serverAppDir = join(stageDir, "apps", "web", ".next", "server", "app");
let removedPublicSite = 0;
for (const entry of publicSiteArtifacts) {
  const target = join(serverAppDir, entry);
  if (!existsSync(target)) continue;
  await rm(target, { recursive: true, force: true });
  removedPublicSite += 1;
}
if (removedPublicSite === 0) {
  throw new Error(
    `staged ${serverAppDir} held none of the public-site routes; the list is stale and the website may be shipping inside the app`,
  );
}
process.stdout.write(
  `desktop: removed ${removedPublicSite} public-site artefact(s) from the staged server\n`,
);

// Next traces apps/web/.env into the standalone output, and it is left there on purpose: the Next
// proxy reads NEXT_PUBLIC_API_URL at request time to build the Content Security Policy. The file holds
// public values only — @symplist/config refuses a secret variable for the web app, and every
// NEXT_PUBLIC_* value is already inlined into the browser bundle — so shipping it discloses nothing.
// A server secret must never be added to it; it would travel inside the .dmg.

process.stdout.write(`desktop: staged the web standalone server into ${stageDir}\n`);
