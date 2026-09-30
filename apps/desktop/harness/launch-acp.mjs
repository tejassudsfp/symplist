// Boots the DeepSeek Harness as an automation-only ACP server on stdio, for the Electron main
// process to drive. It is deliberately not `dsh --profile acp`: `dsh/lib/bin.js` refuses the name
// with "profile \"desktop\" is managed exclusively by the Electron application", and
// `dsh-app-boot` documents the path an application-owned profile takes instead —
// "Application-owned npm projects, such as Electron's reserved Desktop profile, use
// `loadProfileDirectory` to load an already initialized directory without exposing it through CLI
// profile lookup."
//
// This file therefore does by hand what `runProfile` in the dsh launcher does, minus everything a
// desktop app must not inherit: no `--patch` overlay flags, no live patch watching (the profile is
// `patchReload: startup`), no HTTP proxy installation from the environment, and no home-level
// `cordis.patch.yml` layer — the profile Electron generates is the only user layer, so a stray file
// in a shared `$DSH_HOME` cannot change what the app mounts.
//
// It runs under Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), so no second runtime ships. The
// whole tree is Node-API addons, which are ABI-stable across Electron and Node.
//
// It lives at the ROOT of the vendored harness tree, beside its `node_modules`. Every harness
// module it loads is resolved from the dsh installation's own `package.json` rather than from this
// file, because npm's hoisting of a 230-package tree is not something a launcher may bet on: a peer
// conflict inside the release candidate is enough to move the whole `@deepseek-ai` set into
// `node_modules/@deepseek-ai/dsh/node_modules`, where a bare import from the tree root cannot see
// it. Anchoring on the installation is also what keeps one Cordis instance in play, since
// `resolveBundleDir` resolves every profile bundle from that same anchor.
//
// Contract with the parent process:
//   stdin/stdout  JSON-RPC ACP frames, nothing else. Every diagnostic goes to stderr.
//   stderr        dsh's fail-loud diagnostics; the supervisor captures and redacts them.
//   exit          non-zero with one labelled line when boot fails; 0 on stdin EOF or SIGTERM.
//
// Environment, all set by the supervisor:
//   SYMPLIST_DSH_PROFILE          absolute profile directory (required)
//   DSH_HOME                      harness home; holds the profile and the module fallback mirror
//   DSH_PERMISSION_MODE           sandbox mode read by dsh-base's `sandbox-policy` row
//   DSH_TELEMETRY_DISABLED        belt to the generated patch's `disabled: true` brace
//   SYMPLIST_OPENAI_API_KEY       provider keys, referenced by name from the generated patch's
//   SYMPLIST_ANTHROPIC_API_KEY    `llm-pi-ai` routes and resolved per request, never persisted
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The diagnostic prefix on every fail-loud line, so a stderr capture names the right product. */
const NAME = "symplist";

/** Root config filename inside a profile directory; the Loader anchors `baseUrl` on it. */
const PROFILE_ROOT_FILENAME = "cordis.yml";

/** How long a signal-initiated disposal may take before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function fail(message) {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(1);
}

const profileDir = process.env.SYMPLIST_DSH_PROFILE;
if (!profileDir) {
  fail(
    "SYMPLIST_DSH_PROFILE is not set; the Electron main process must generate the profile first",
  );
}

// This dsh installation's package.json is the first of `loadProfileDirectory`'s two resolution
// anchors, and the anchor `healProfilesModuleFallback` mirrors the dependency closure from. dsh
// publishes no `exports` map, so the subpath resolves directly.
const installAnchor = fileURLToPath(
  pathToFileURL(createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json")),
);

/** Load one harness module from the installation's own dependency tree. */
const fromInstall = createRequire(installAnchor);
const loadHarnessModule = (specifier) => import(pathToFileURL(fromInstall.resolve(specifier)).href);

const { boot, healProfilesModuleFallback, installFailLoud, loadProfileDirectory } =
  await loadHarnessModule("@deepseek-ai/dsh-app-boot");
const { provideCmdline } = await loadHarnessModule("@deepseek-ai/dsh-cmdline");
const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await loadHarnessModule(
  "@deepseek-ai/dsh-launch-environment",
);

// Installed before boot so a late unhandled plugin-init rejection becomes one labelled stderr line
// and a non-zero exit rather than a half-started tree. It never touches stdout, which is the ACP
// wire.
installFailLoud(NAME, process);

const profile = loadProfileDirectory(NAME, profileDir, installAnchor);

// The plugin rows the composed tree mounts are bare package specifiers resolved by walking up from
// the profile directory, and the profile directory is a generated directory in `userData` with no
// `node_modules` of its own. This call is what makes them resolvable: it mirrors the installation's
// dependency closure into `$DSH_HOME/profiles/node_modules` as symlinks, which the parent walk from
// the profile directory then finds. Links live in the writable harness home and point into the
// read-only app bundle, so nothing is written inside `Resources`.
//
// `boot`'s `bareModuleBaseUrl` would be the alternative, and it is the wrong one here: it resolves
// every bare specifier against one directory, and npm's hoisting nests the harness tree (a version
// conflict puts `@deepseek-ai/dsh-agent` under `dsh-base/node_modules`, not at the root), so a
// single base directory cannot see the whole plugin set.
await healProfilesModuleFallback({ installAnchor, profile, home: process.env.DSH_HOME });

// Bundle layers in `dsh.profile.bundles` order, then the profile's own layer — the same order
// `composeProfile` applies, without the home-level layer or `--patch` overlays.
const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches];

const app = { ctx: undefined };

/** Dispose the tree, then exit — bounded, because a wedged plugin must not hold the process open. */
let exiting = false;
function shutdown(code) {
  if (exiting) {
    process.exit(code);
  }
  exiting = true;
  const timer = setTimeout(() => process.exit(code), SHUTDOWN_TIMEOUT_MS);
  void Promise.resolve()
    .then(() => app.ctx?.fiber.dispose())
    .then(
      () => {
        clearTimeout(timer);
        process.exit(code);
      },
      () => {
        clearTimeout(timer);
        process.exit(code);
      },
    );
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// `dsh-acp-app` refuses to mount without a readiness signal — "the launcher must provide
// ctx.appExit and ctx.appReady before the tree mounts" — because it binds process lifetime to stdin
// EOF and must not arm that before startup succeeded. Committed only after `boot` resolves, so a
// failed boot never runs a listener that assumes a serving tree.
const readyListeners = new Set();
let ready = false;
const readyService = {
  onReady(listener) {
    if (ready) {
      listener();
      return () => {};
    }
    readyListeners.add(listener);
    return () => readyListeners.delete(listener);
  },
};
function commitReady() {
  if (ready) return;
  ready = true;
  for (const listener of [...readyListeners]) listener();
  readyListeners.clear();
}

app.ctx = await boot(
  NAME,
  join(profile.dir, PROFILE_ROOT_FILENAME),
  structuredClone(patches),
  (ctx) => {
    app.ctx = ctx;
    // The launch environment is where the provider keys enter, and the only place they exist: this
    // layer is read-only to the harness, so `dsh-credentials-local` resolves an `apiKeyEnv`
    // reference against it per request and can never persist the value to
    // `$DSH_HOME/.credentials.yaml`.
    ctx.provide(
      DSH_LAUNCH_ENVIRONMENT_KEY,
      createLaunchEnvironmentSnapshot([{ source: "process", values: { ...process.env } }]),
    );
    // `dsh-acp-app` publishes `acpAppStartup` only from its commander action, and the `acp` row
    // waits on that service — so a host that skips this boots a tree that never serves. The app
    // takes no arguments of its own; the profile carries every decision.
    provideCmdline(ctx, { args: [], exit: (code) => shutdown(code), ready: readyService });
  },
);

if (!exiting) commitReady();
