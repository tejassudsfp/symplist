/**
 * Where the vendored DeepSeek Harness is, and whether it is there at all.
 *
 * Pure policy, the way `navigation.ts` sits beside `window.ts`: it takes the candidate directories
 * and a `exists` probe, so a test can exercise every outcome without a 290MB tree on disk.
 *
 * The tree is ~290MB of real files under `Resources`, never inside `app.asar`, because four of its
 * packages load Node-API addons from disk (`node-pty`, `@img/sharp`, `node-addon-require-builtin`,
 * `@deepseek-ai/node-addon-system`) and a `.node` file cannot be loaded out of an archive. That is
 * also why absence is a state this module reports rather than an exception: a build whose
 * `extraResources` step was skipped must show the user a sentence, not crash the window.
 */

/** The launcher's filename at the root of the vendored tree. */
export const HARNESS_LAUNCHER = "launch-acp.mjs";

/** The dsh release this desktop build is vendored against, pinned exactly — never a caret. */
export const HARNESS_DSH_VERSION = "0.1.5-rc.2";

/** A resolved harness tree: the directory holding `node_modules`, and the launcher inside it. */
export interface HarnessLocation {
  readonly root: string;
  readonly launcher: string;
}

export interface LocateHarnessInput {
  /**
   * Candidate tree roots, most specific first. The supervisor supplies, in order: an explicit
   * `SYMPLIST_DSH_HARNESS` override (the spike and development path), `<Resources>/harness` when
   * packaged, and `apps/desktop/build/harness` when run from the workspace.
   */
  readonly candidates: readonly string[];
  /** Whether a path exists; injected so this stays testable without a filesystem. */
  readonly exists: (path: string) => boolean;
  /** Path join, injected for the same reason — `node:path` is not imported here. */
  readonly join: (...segments: string[]) => string;
}

/**
 * Pick the first candidate that carries both a launcher and a `node_modules`. Both are required:
 * a tree with a launcher and no modules is a vendoring step that ran halfway, and booting it would
 * fail deep inside dsh's module resolution instead of here, where the message can name the cause.
 */
export function locateHarness(input: LocateHarnessInput): HarnessLocation | null {
  for (const root of input.candidates) {
    if (root.length === 0) continue;
    const launcher = input.join(root, HARNESS_LAUNCHER);
    if (!input.exists(launcher)) continue;
    if (!input.exists(input.join(root, "node_modules"))) continue;
    return { root, launcher };
  }
  return null;
}
