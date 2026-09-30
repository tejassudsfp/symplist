// Bundles the main process and the preload script to single files with esbuild.
//
// Bundling is not an optimization here: electron-builder would otherwise have to pack pnpm's symlinked
// node_modules into the app, which it cannot do reliably. One file each also means the packaged app
// carries no workspace layout at all.
//
// Usage: node scripts/build.mjs    (pnpm --filter @symplist/desktop build)
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appDir = fileURLToPath(new URL("../", import.meta.url));

await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: "node",
  // Electron 44 embeds Node 24, which is also the repo's engine range.
  target: "node24",
  sourcemap: true,
  // Electron's own modules are supplied by the runtime and must never be bundled.
  external: ["electron"],
  logLevel: "warning",
  absWorkingDir: appDir,
};

await build({
  ...shared,
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main.js",
  // The app's package.json is `type: module`, so the main entry is loaded as ESM.
  format: "esm",
});

await build({
  ...shared,
  entryPoints: ["src/preload/index.ts"],
  // `.cjs`, because a sandboxed preload script is evaluated as CommonJS: ESM preload requires
  // `sandbox: false`, and the sandbox is worth more than the module syntax.
  outfile: "dist/preload.cjs",
  format: "cjs",
});

process.stdout.write("desktop: bundled dist/main.js and dist/preload.cjs\n");
