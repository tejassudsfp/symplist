import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { GitError } from "./errors.ts";

/** Operation directories are named with this prefix so the sweep never touches anything else. */
export const GIT_WORKSPACE_PREFIX = "symgit-";

/**
 * A private temporary directory for one Git operation (§9.1): `repo.git` (the bare repository),
 * `home` (an empty `HOME`) and space for one decrypted bundle file. Everything in it is plaintext
 * document history and is removed by {@link GitWorkspace.dispose} in a `finally` block; a process that
 * crashed first leaves it to the startup sweep.
 */
export interface GitWorkspace {
  readonly dir: string;
  readonly repoDir: string;
  readonly homeDir: string;
  /** A path for a bundle file inside the workspace. */
  bundlePath(name: string): string;
  dispose(): Promise<void>;
}

/**
 * The root under `GIT_TMP_DIR` holding operation directories. The root is created with mode 0700 and
 * must be a real directory (never a symlink), and every operation gets its own `mkdtemp` directory.
 */
export class GitTempRoot {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError("GIT_TMP_DIR must be an absolute directory");
    this.root = root;
  }

  /** Creates the root when missing and checks that it is a private directory, not a symlink. */
  async ensure(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new GitError("git.unavailable", { subcommand: "workspace" });
    }
    await chmod(this.root, 0o700);
  }

  /** Creates a fresh operation directory. */
  async create(): Promise<GitWorkspace> {
    await this.ensure();
    const dir = await mkdtemp(join(this.root, GIT_WORKSPACE_PREFIX));
    await chmod(dir, 0o700);
    const repoDir = join(dir, "repo.git");
    const homeDir = join(dir, "home");
    await mkdir(homeDir, { mode: 0o700 });
    let disposed = false;
    return {
      dir,
      repoDir,
      homeDir,
      bundlePath: (name) => {
        if (!/^[a-z0-9-]{1,32}\.bundle$/.test(name)) throw new TypeError("Invalid bundle name");
        return join(dir, name);
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      },
    };
  }

  /**
   * Removes operation directories last modified before `olderThan` (epoch milliseconds), left by a
   * crashed process. Runs at startup and periodically; returns how many it removed. Operation
   * directories of running operations are younger than any operation's time limit, so the caller picks
   * a threshold well beyond it.
   */
  async sweep(olderThan: number): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith(GIT_WORKSPACE_PREFIX)) continue;
      const path = join(this.root, name);
      try {
        const info = await stat(path);
        if (info.mtimeMs >= olderThan) continue;
        await rm(path, { recursive: true, force: true, maxRetries: 3 });
        removed += 1;
      } catch {
        // Removed concurrently, or unreadable; the next sweep tries again.
      }
    }
    return removed;
  }

  /** Operation directories currently present, for cleanup tests and diagnostics. */
  async list(): Promise<string[]> {
    try {
      return (await readdir(this.root)).filter((name) => name.startsWith(GIT_WORKSPACE_PREFIX));
    } catch {
      return [];
    }
  }
}
