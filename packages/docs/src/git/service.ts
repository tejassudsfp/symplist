import { findGitExecutable } from "./environment.ts";
import { GitError } from "./errors.ts";
import { GitRepository, type GitRepositoryLimits } from "./repository.ts";
import { execGit, type GitCommandRunner } from "./runner.ts";
import { GitTempRoot } from "./workspace.ts";

/** Bounds on Git work (§9.1, note 11 "Runtime and Git operations"). */
export interface GitServiceLimits {
  /** Operations holding a private repository at once (the api allows 2). */
  readonly maxConcurrent: number;
  /** Operations waiting for a slot; one more is refused with `git.busy`. */
  readonly maxQueued: number;
  /** Wall-clock limit per Git command. */
  readonly commandTimeoutMs: number;
  /** Largest stdout of an ordinary command. */
  readonly maxCommandOutputBytes: number;
  /** Largest document blob. */
  readonly maxBlobBytes: number;
  /** Largest diff output. */
  readonly maxDiffBytes: number;
  /** Largest bundle written or reconstructed; bounds temp disk use per operation to about twice it. */
  readonly maxBundleBytes: number;
  /** Startup and periodic sweeps remove operation directories older than this. */
  readonly staleWorkspaceMs: number;
}

export const DEFAULT_GIT_LIMITS: GitServiceLimits = Object.freeze({
  maxConcurrent: 2,
  maxQueued: 16,
  commandTimeoutMs: 30_000,
  maxCommandOutputBytes: 4 * 1024 * 1024,
  maxBlobBytes: 1_048_576,
  maxDiffBytes: 4 * 1024 * 1024,
  maxBundleBytes: 64 * 1024 * 1024,
  staleWorkspaceMs: 15 * 60 * 1000,
});

export interface GitServiceOptions {
  /** `GIT_TMP_DIR`. */
  readonly tempDir: string;
  /** The Git executable; found among the standard locations when omitted. */
  readonly gitPath?: string;
  readonly limits?: Partial<GitServiceLimits>;
  /** Replaces `execFile` (tests inject failures). */
  readonly runner?: GitCommandRunner;
}

/**
 * The Git service shared by the api and the `document-git` task (§9.1). Each operation gets a fresh
 * private repository in its own temp directory, holds one of a bounded number of slots, and removes
 * its plaintext in `finally`, whether it succeeded or failed.
 */
export class GitService {
  readonly limits: GitServiceLimits;
  readonly tempRoot: GitTempRoot;
  private readonly gitPath: string | undefined;
  private readonly runner: GitCommandRunner;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: GitServiceOptions) {
    this.limits = Object.freeze({ ...DEFAULT_GIT_LIMITS, ...options.limits });
    this.tempRoot = new GitTempRoot(options.tempDir);
    this.gitPath = options.gitPath ?? findGitExecutable();
    this.runner = options.runner ?? execGit;
  }

  /** Operations holding a slot. */
  get running(): number {
    return this.active;
  }

  /** Operations waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limits.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.waiting.length >= this.limits.maxQueued) throw new GitError("git.busy");
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  /**
   * Runs `operation` with a fresh, initialized private bare repository. The temp directory is removed
   * afterwards in every case.
   */
  async withRepository<Result>(
    operation: (repository: GitRepository) => Promise<Result>,
  ): Promise<Result> {
    if (!this.gitPath) throw new GitError("git.unavailable");
    await this.acquire();
    try {
      const workspace = await this.tempRoot.create();
      try {
        const repositoryLimits: GitRepositoryLimits = {
          command: {
            timeoutMs: this.limits.commandTimeoutMs,
            maxOutputBytes: this.limits.maxCommandOutputBytes,
          },
          maxBlobBytes: this.limits.maxBlobBytes,
          maxDiffBytes: this.limits.maxDiffBytes,
        };
        const repository = new GitRepository({
          workspace,
          gitPath: this.gitPath,
          runner: this.runner,
          limits: repositoryLimits,
        });
        await repository.init();
        return await operation(repository);
      } finally {
        await workspace.dispose();
      }
    } finally {
      this.release();
    }
  }

  /** Removes operation directories a crashed process left behind (§9.1 startup sweep). */
  async sweepStaleWorkspaces(now: number = Date.now()): Promise<number> {
    return this.tempRoot.sweep(now - this.limits.staleWorkspaceMs);
  }

  /** Whether a Git executable was found. */
  get available(): boolean {
    return this.gitPath !== undefined;
  }
}
