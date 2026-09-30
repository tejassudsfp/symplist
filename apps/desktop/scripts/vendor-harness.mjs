// Materialises the DeepSeek Harness into `build/harness`, which electron-builder ships as
// `<App>.app/Contents/Resources/harness`.
//
// Usage: node scripts/vendor-harness.mjs    (pnpm --filter @symplist/desktop vendor:harness)
//
// ## Why npm, not pnpm
//
// pnpm's store is a symlink farm, and electron-builder cannot pack one reliably — the same reason
// main and preload are bundled to single files. dsh's own profile scaffolding says as much about
// itself: the `pnpm-workspace.yaml` it writes into a profile sets `nodeLinker: hoisted` and
// `autoInstallPeers: false`, because its plugin set needs real files and its release-candidate peer
// ranges do not resolve strictly. A plain `npm install` of the one package produces exactly that:
// real files, one flat `node_modules`, and `@deepseek-ai/dsh` pulling the whole plugin set in as
// ordinary dependencies.
//
// Two flags that look like improvements are not, and both were measured rather than guessed:
//
//   * `--install-strategy=hoisted` *nests* this tree instead of flattening it. A peer conflict inside
//     the release candidate (`dsh-home-paths` pins `cordis` exactly; `cordis-plugin-include` wants a
//     newer patch) pushes all 230 `@deepseek-ai` packages under `node_modules/@deepseek-ai/dsh/
//     node_modules`, which the launcher then cannot resolve from the tree root.
//   * `--omit=dev` does the same thing for the same reason.
//
// So the install is plain. `--ignore-scripts` stays, because every native addon in the tree ships a
// prebuild and nothing here needs to compile: the four Node-API addons (`node-pty`, `@img/sharp`,
// `node-addon-require-builtin`, `@deepseek-ai/node-addon-system`) load from disk, which is also why
// the tree must sit outside `app.asar`.
//
// ## Size
//
// ~290MB installed, and pruning foreign-platform prebuilds takes a bite out of it. This is the honest
// cost of shipping a harness; there is no version of it that is small.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The dsh release this build is vendored against, pinned exactly — never a caret. */
const DSH_VERSION = "0.1.5-rc.2";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const target = join(appDir, "build", "harness");

/**
 * Prebuilt binaries for platforms this build does not target. They are optional dependencies npm
 * installs for every platform, and each one is tens of megabytes of code that can never run here.
 */
const foreignPrebuildPatterns = [
  /^@img[/\\]sharp-(linux|linuxmusl|win32|wasm32)/,
  /^node-pty[/\\]prebuilds[/\\](win32|linux|android)-/,
  /^@deepseek-ai[/\\]node-addon-system-(?!darwin-arm64)/,
];

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** Every path under `root` matching one of the patterns, relative to `root`. */
function foreignPaths(root) {
  const found = [];
  const walk = (relative, depth) => {
    if (depth > 4) return;
    const absolute = join(root, relative);
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = relative === "" ? entry.name : join(relative, entry.name);
      if (foreignPrebuildPatterns.some((pattern) => pattern.test(next))) {
        found.push(next);
        continue;
      }
      if (entry.isDirectory()) walk(next, depth + 1);
    }
  };
  walk("", 0);
  return found;
}

function bytes(root) {
  let total = 0;
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        try {
          total += statSync(next).size;
        } catch {
          // A file that vanished between listing and stat contributes nothing; nothing is broken.
        }
      }
    }
  };
  walk(root);
  return total;
}

// A clean tree every time. An incremental install would leave a package behind after a version bump,
// and a stale plugin in a 230-package tree fails at boot with a message about something else.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

writeFileSync(
  join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "symplist-desktop-harness",
      private: true,
      version: "0.0.0",
      description: "The vendored DeepSeek Harness the Symplist desktop app drives over ACP.",
      // One dependency, pinned. Everything else in the tree is its closure, which is what keeps the
      // version of the assistant a one-line fact.
      dependencies: { "@deepseek-ai/dsh": DSH_VERSION },
    },
    undefined,
    2,
  )}\n`,
);

run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], target);

// The launcher lives at the tree root, beside `node_modules`: it resolves the dsh installation by
// walking up from its own location, then resolves every harness module from that installation.
await copyFile(join(appDir, "harness", "launch-acp.mjs"), join(target, "launch-acp.mjs"));

if (!existsSync(join(target, "node_modules", "@deepseek-ai", "dsh", "package.json"))) {
  throw new Error("desktop: the harness install produced no @deepseek-ai/dsh at the tree root");
}

const before = bytes(target);
let pruned = 0;
for (const relative of foreignPaths(join(target, "node_modules"))) {
  rmSync(join(target, "node_modules", relative), { recursive: true, force: true });
  pruned += 1;
}
const after = bytes(target);

process.stdout.write(
  `desktop: vendored @deepseek-ai/dsh@${DSH_VERSION} into build/harness ` +
    `(${Math.round(after / 1e6)}MB, pruned ${pruned} foreign-platform paths, ` +
    `${Math.round((before - after) / 1e6)}MB saved)\n`,
);
