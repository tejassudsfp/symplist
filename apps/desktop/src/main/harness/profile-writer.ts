/**
 * Puts the generated profile on disk before each spawn.
 *
 * Deliberately thin: everything worth asserting is in `profile.ts`, which renders the text. This
 * file only decides *where*, and the where is `<userData>/dsh/profiles/desktop` — under a `DSH_HOME`
 * of `<userData>/dsh`, because the launcher's module fallback mirrors the harness dependency closure
 * into `<DSH_HOME>/profiles/node_modules` and the profile directory's parent walk has to reach it.
 *
 * Regenerated on every launch rather than created once. The patch encodes which provider keys the
 * keychain holds and which model the account chose, and both can change while the app is closed;
 * a profile written at install time would quietly serve last month's answer.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantProvider, ProfilePatchInput } from "./profile.ts";
import { renderProfileManifest, renderProfilePatch, renderProfileRoot } from "./profile.ts";

/** The reserved profile name. `dsh --profile desktop` refuses; only this application boots it. */
const PROFILE_NAME = "desktop";

/** The harness home and profile directory of one desktop installation. */
export interface HarnessProfilePaths {
  /** `$DSH_HOME`: holds the profile, the module fallback mirror and dsh's own session files. */
  readonly home: string;
  /** The profile directory the launcher is pointed at. */
  readonly dir: string;
}

/** Where the profile lives for a given Electron `userData` directory. */
export function harnessProfilePaths(userData: string): HarnessProfilePaths {
  const home = join(userData, "dsh");
  return { home, dir: join(home, "profiles", PROFILE_NAME) };
}

export interface WriteProfileOptions extends ProfilePatchInput {
  readonly userData: string;
}

/**
 * Write the three files a dsh profile is made of, creating the directory tree on the way. Returns
 * the paths the supervisor hands the child.
 */
export async function writeHarnessProfile(
  options: WriteProfileOptions,
): Promise<HarnessProfilePaths> {
  const paths = harnessProfilePaths(options.userData);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(join(paths.dir, "package.json"), renderProfileManifest(), "utf8");
  await writeFile(join(paths.dir, "cordis.yml"), renderProfileRoot(), "utf8");
  await writeFile(
    join(paths.dir, "cordis.patch.yml"),
    renderProfilePatch({
      providers: options.providers,
      defaultProvider: options.defaultProvider,
      defaultModel: options.defaultModel,
    }),
    "utf8",
  );
  return paths;
}

export type { AssistantProvider };
