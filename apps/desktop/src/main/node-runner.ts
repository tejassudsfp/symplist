import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The executable to spawn when main needs a Node child.
 *
 * Both children — the Next server and the harness launcher — run Node code, and both use Electron's
 * own binary with `ELECTRON_RUN_AS_NODE` so the app ships one runtime rather than two. The obvious
 * binary to reach for is `process.execPath`, and on macOS that is the wrong one: it is
 * `Symplist.app/Contents/MacOS/Symplist`, the bundle's main executable, and that bundle has no
 * `LSUIElement`. Launching it again gives the child a second Dock icon, which bounces while it
 * starts and then sits there for the life of the app — one window, two icons.
 *
 * Electron ships a helper bundle for exactly this, and its `Info.plist` sets `LSUIElement` so it
 * never appears in the Dock. Spawning that instead costs nothing and the child is identical: same
 * binary lineage, same Node, same `ELECTRON_RUN_AS_NODE` contract.
 *
 * Only macOS has the helper layout. Elsewhere — and in a dev run, where `execPath` is Electron in
 * `node_modules` rather than an app bundle — `process.execPath` is already correct, and the
 * existence check is what decides rather than a guess about packaging.
 */
export function nodeRunnerPath(execPath: string = process.execPath): string {
  if (process.platform !== "darwin") return execPath;
  // …/Symplist.app/Contents/MacOS/Symplist → …/Symplist.app/Contents
  const macOs = dirname(execPath);
  const contents = dirname(macOs);
  if (!contents.endsWith("/Contents")) return execPath;
  const name = execPath.slice(macOs.length + 1);
  const helper = join(
    contents,
    "Frameworks",
    `${name} Helper.app`,
    "Contents",
    "MacOS",
    `${name} Helper`,
  );
  return existsSync(helper) ? helper : execPath;
}
