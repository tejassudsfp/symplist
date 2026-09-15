import { readFile, stat, writeFile } from "node:fs/promises";
import { type GitIdentity, gitEnvironment } from "./environment.ts";
import { GitError } from "./errors.ts";
import type { GitCommandLimits, GitCommandRunner } from "./runner.ts";
import type { GitWorkspace } from "./workspace.ts";

/** The only branch and path Symplist writes (note 11 "Repository boundary"). */
export const DOCUMENT_REF = "refs/heads/main";
export const DOCUMENT_PATH = "document.md";
export const ZERO_OID = "0000000000000000000000000000000000000000";

const oidPattern = /^[0-9a-f]{40}$/;

export function assertOid(value: string): string {
  if (typeof value !== "string" || !oidPattern.test(value)) {
    throw new GitError("git.integrity_failed", { subcommand: "oid" });
  }
  return value;
}

/** One commit as read from the repository's history. */
export interface GitLogEntry {
  readonly commitId: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  /** Author date in epoch seconds. */
  readonly authoredAt: number;
  /** The full commit message. */
  readonly message: string;
}

export interface GitRepositoryLimits {
  readonly command: GitCommandLimits;
  /** Largest diff output accepted. */
  readonly maxDiffBytes: number;
  /** Largest blob (document) read. */
  readonly maxBlobBytes: number;
}

/**
 * Git plumbing on one private bare repository (§9.1, research "Git plumbing"): blobs, trees and
 * commits with explicit parents, identities and dates; compare-and-swap ref updates; bundles;
 * integrity checks; bounded history and diffs. Every revision passed in must already be a validated
 * 40-hex object id; callers never pass ref expressions, paths or remote URLs.
 */
export class GitRepository {
  readonly workspace: GitWorkspace;
  private readonly gitPath: string;
  private readonly run: GitCommandRunner;
  private readonly limits: GitRepositoryLimits;

  constructor(options: {
    readonly workspace: GitWorkspace;
    readonly gitPath: string;
    readonly runner: GitCommandRunner;
    readonly limits: GitRepositoryLimits;
  }) {
    this.workspace = options.workspace;
    this.gitPath = options.gitPath;
    this.run = options.runner;
    this.limits = options.limits;
  }

  private async git(
    args: readonly string[],
    options: {
      readonly input?: Uint8Array;
      readonly identity?: GitIdentity;
      readonly maxOutputBytes?: number;
      readonly okExitCodes?: readonly number[];
      readonly bare?: boolean;
    } = {},
  ) {
    return this.run(this.gitPath, {
      args,
      cwd: this.workspace.dir,
      env: gitEnvironment({
        ...(options.bare === false ? {} : { gitDir: this.workspace.repoDir }),
        home: this.workspace.homeDir,
        ...(options.identity ? { identity: options.identity } : {}),
      }),
      ...(options.input ? { input: options.input } : {}),
      limits: {
        timeoutMs: this.limits.command.timeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? this.limits.command.maxOutputBytes,
      },
      ...(options.okExitCodes ? { okExitCodes: options.okExitCodes } : {}),
    });
  }

  private static oidOutput(stdout: Buffer, subcommand: string): string {
    const text = stdout.toString("utf8").trim();
    if (!oidPattern.test(text)) throw new GitError("git.integrity_failed", { subcommand });
    return text;
  }

  /** `git init --bare` with no template, so no sample hooks are copied. */
  async init(): Promise<void> {
    await this.git(
      ["init", "--bare", "--quiet", "--template=", "--initial-branch=main", this.workspace.repoDir],
      { bare: false },
    );
  }

  /** Writes the document as a blob (stdin implies `--no-filters`). */
  async writeBlob(content: Uint8Array): Promise<string> {
    if (content.byteLength > this.limits.maxBlobBytes) {
      throw new GitError("git.limit_exceeded", { subcommand: "hash-object" });
    }
    const { stdout } = await this.git(["hash-object", "-w", "--stdin"], { input: content });
    return GitRepository.oidOutput(stdout, "hash-object");
  }

  /** A tree holding only `document.md`. */
  async writeDocumentTree(blob: string): Promise<string> {
    const line = `100644 blob ${assertOid(blob)}\t${DOCUMENT_PATH}\n`;
    const { stdout } = await this.git(["mktree"], { input: Buffer.from(line, "utf8") });
    return GitRepository.oidOutput(stdout, "mktree");
  }

  /** A commit with explicit parents, identity and date; the message comes from stdin. */
  async commitTree(input: {
    readonly tree: string;
    readonly parents: readonly string[];
    readonly message: string;
    readonly identity: GitIdentity;
  }): Promise<string> {
    const args = ["commit-tree", assertOid(input.tree)];
    for (const parent of input.parents) args.push("-p", assertOid(parent));
    args.push("-F", "-");
    const { stdout } = await this.git(args, {
      input: Buffer.from(input.message, "utf8"),
      identity: input.identity,
    });
    return GitRepository.oidOutput(stdout, "commit-tree");
  }

  /** Compare-and-swap of `refs/heads/main`: `expected` null means the ref must not exist. */
  async updateMain(next: string, expected: string | null): Promise<void> {
    await this.git([
      "update-ref",
      DOCUMENT_REF,
      assertOid(next),
      expected ? assertOid(expected) : ZERO_OID,
    ]);
  }

  /** The commit `refs/heads/main` points at, or null when it does not exist. */
  async readMain(): Promise<string | null> {
    const { stdout, exitCode } = await this.git(
      ["rev-parse", "--verify", "--quiet", DOCUMENT_REF],
      {
        okExitCodes: [0, 1],
      },
    );
    if (exitCode !== 0) return null;
    return GitRepository.oidOutput(stdout, "rev-parse");
  }

  /** The tree of a commit. */
  async treeOf(commit: string): Promise<string> {
    const { stdout } = await this.git(["rev-parse", "--verify", `${assertOid(commit)}^{tree}`]);
    return GitRepository.oidOutput(stdout, "rev-parse");
  }

  /** The document at a commit, bounded by the blob limit. */
  async readDocument(commit: string): Promise<Buffer> {
    const { stdout } = await this.git(
      ["cat-file", "blob", `${assertOid(commit)}:${DOCUMENT_PATH}`],
      {
        maxOutputBytes: this.limits.maxBlobBytes,
      },
    );
    return stdout;
  }

  /** `git fsck --strict` over every object, without reporting dangling objects. */
  async fsck(): Promise<void> {
    await this.git(["fsck", "--strict", "--no-dangling", "--no-progress"]);
  }

  /** The number of commits reachable from `commit`. */
  async commitCount(commit: string): Promise<number> {
    const { stdout } = await this.git(["rev-list", "--count", assertOid(commit)]);
    const count = Number(stdout.toString("utf8").trim());
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new GitError("git.integrity_failed", { subcommand: "rev-list" });
    }
    return count;
  }

  /** Whether `ancestor` is reachable from `descendant` (or equal to it). */
  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const { exitCode } = await this.git(
      ["merge-base", "--is-ancestor", assertOid(ancestor), assertOid(descendant)],
      { okExitCodes: [0, 1] },
    );
    return exitCode === 0;
  }

  /** Whether an object id names a commit present in the repository. */
  async hasCommit(commit: string): Promise<boolean> {
    const { stdout, exitCode } = await this.git(["cat-file", "-t", assertOid(commit)], {
      okExitCodes: [0, 1, 128],
    });
    return exitCode === 0 && stdout.toString("utf8").trim() === "commit";
  }

  /** Writes a self-contained bundle of `refs/heads/main` and returns its bytes. */
  async createBundle(name: string, maxBytes: number): Promise<Buffer> {
    const path = this.workspace.bundlePath(name);
    await this.git(["bundle", "create", "--quiet", path, DOCUMENT_REF]);
    const info = await stat(path);
    if (info.size > maxBytes) throw new GitError("git.limit_exceeded", { subcommand: "bundle" });
    return readFile(path);
  }

  /**
   * Writes a bundle file into the workspace, verifies it against this (empty) repository, and
   * unbundles it, returning the refs the bundle carries. `bundle verify` fails when prerequisites are
   * missing, so only a self-contained bundle passes.
   */
  async unbundle(name: string, bundle: Uint8Array): Promise<Map<string, string>> {
    const path = this.workspace.bundlePath(name);
    await writeFile(path, bundle, { mode: 0o600, flag: "wx" });
    await this.git(["bundle", "verify", path], { maxOutputBytes: 64 * 1024 });
    const { stdout } = await this.git(["bundle", "unbundle", path], { maxOutputBytes: 64 * 1024 });
    const refs = new Map<string, string>();
    for (const line of stdout.toString("utf8").split("\n")) {
      if (line.trim() === "") continue;
      const match = /^([0-9a-f]{40}) (\S+)$/.exec(line.trim());
      if (!match) throw new GitError("git.integrity_failed", { subcommand: "bundle" });
      refs.set(match[2] as string, match[1] as string);
    }
    return refs;
  }

  /**
   * A page of first-parent history from `head`, newest first. Messages Symplist writes never contain
   * the record and field separators used here.
   */
  async log(head: string, skip: number, limit: number): Promise<GitLogEntry[]> {
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1) {
      throw new GitError("git.limit_exceeded", { subcommand: "log" });
    }
    const { stdout } = await this.git([
      "log",
      "--no-color",
      "--first-parent",
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%B%x1e",
      `--skip=${skip}`,
      `--max-count=${limit}`,
      assertOid(head),
      "--",
    ]);
    const entries: GitLogEntry[] = [];
    for (const record of stdout.toString("utf8").split("\x1e")) {
      const trimmed = record.replace(/^\n+/, "");
      if (trimmed.length === 0) continue;
      const [commitId, parents, authorName, authorEmail, authoredAt, ...message] =
        trimmed.split("\x1f");
      if (!commitId || !oidPattern.test(commitId) || authoredAt === undefined) {
        throw new GitError("git.integrity_failed", { subcommand: "log" });
      }
      entries.push({
        commitId,
        parents: (parents ?? "").split(" ").filter((parent) => oidPattern.test(parent)),
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        authoredAt: Number(authoredAt),
        message: message.join("\x1f").replace(/\n+$/, ""),
      });
    }
    return entries;
  }

  /**
   * The unified diff of `document.md` between two commits with external diff drivers and text
   * conversion disabled (§9.1), bounded by `maxDiffBytes`.
   */
  async diff(base: string, target: string, contextLines = 3): Promise<string> {
    const { stdout } = await this.git(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--diff-algorithm=histogram",
        `-U${Math.max(0, Math.min(10, Math.trunc(contextLines)))}`,
        assertOid(base),
        assertOid(target),
        "--",
        DOCUMENT_PATH,
      ],
      { maxOutputBytes: this.limits.maxDiffBytes },
    );
    return stdout.toString("utf8");
  }
}
