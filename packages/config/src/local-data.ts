import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Local development data (`DATA_DRIVER=local`, decision A7): one directory holds the SQLite file that
 * stands in for D1 and the filesystem object store that stands in for R2. The api and `trigger dev`
 * read the same `LOCAL_DATA_DIR`, so both runtimes share one database and one object store. Node-only.
 */

/** The directory name local data lives in under the repository root. It is gitignored. */
export const localDataDirName = ".local-data";

/** The file that marks the repository root: the pnpm workspace manifest. */
export const workspaceMarkerFile = "pnpm-workspace.yaml";

export interface LocalDataDirOptions {
  /** Where the search for the repository root starts; defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Whether a path exists; defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/**
 * The default `LOCAL_DATA_DIR`: `<repo>/.local-data`, where `<repo>` is the nearest directory at or
 * above the working directory that holds `pnpm-workspace.yaml`. The api runs from `apps/api` and
 * `trigger dev` from `apps/worker` (its task processes may run deeper, in a build directory), so both
 * resolve the same absolute directory. Outside a workspace (a deployed image, where the local drivers
 * are refused anyway) it is `<cwd>/.local-data`.
 */
export function defaultLocalDataDir(options: LocalDataDirOptions = {}): string {
  const start = resolve(options.cwd ?? process.cwd());
  const exists = options.exists ?? existsSync;
  let current = start;
  for (;;) {
    if (exists(join(current, workspaceMarkerFile))) return join(current, localDataDirName);
    const parent = dirname(current);
    if (parent === current) return join(start, localDataDirName);
    current = parent;
  }
}

/** Whether a configured `LOCAL_DATA_DIR` is acceptable: an absolute path without NUL bytes. */
export function isValidLocalDataDir(value: string): boolean {
  return isAbsolute(value) && !value.includes("\u0000");
}

/** The files `DATA_DRIVER=local` keeps under a local data directory, identical in every runtime. */
export interface LocalDataPaths {
  /** The `node:sqlite` database standing in for D1. */
  readonly database: string;
  /** The root of the filesystem object store standing in for R2. */
  readonly objects: string;
}

/** The SQLite file and object store root under `LOCAL_DATA_DIR`. */
export function localDataPaths(localDataDir: string): LocalDataPaths {
  if (!isValidLocalDataDir(localDataDir)) {
    throw new TypeError("LOCAL_DATA_DIR must be an absolute directory path");
  }
  return Object.freeze({
    database: join(localDataDir, "d1.sqlite"),
    objects: join(localDataDir, "objects"),
  });
}
