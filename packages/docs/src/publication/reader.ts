import type { AccountDataKey } from "@symplist/crypto";
import type { DocumentArtifacts } from "../artifacts/store.ts";
import { DocumentError } from "../errors.ts";
import { type DiffHunk, parseUnifiedDiff } from "../git/diff.ts";
import { GitError } from "../git/errors.ts";
import type { GitRepository } from "../git/repository.ts";
import type { GitService } from "../git/service.ts";
import { type HistoryCommit, historyCommitFromLog, reconstructRepository } from "./history.ts";
import type { RepoRecord } from "./records.ts";

/**
 * Read-only Git operations on a published repository (§9.2: `task_document_diff` and
 * `task_document_history` reconstruct Git): each reconstructs the head bundle into a private
 * repository, verifies it, runs bounded plumbing and removes the plaintext.
 */
export class DocumentHistoryReader {
  private readonly git: GitService;
  private readonly artifacts: DocumentArtifacts;

  constructor(options: { readonly git: GitService; readonly artifacts: DocumentArtifacts }) {
    this.git = options.git;
    this.artifacts = options.artifacts;
  }

  private async withHead<Result>(
    repo: RepoRecord,
    accountKey: AccountDataKey,
    operation: (repository: GitRepository) => Promise<Result>,
  ): Promise<Result> {
    try {
      return await this.git.withRepository(async (repository) => {
        await reconstructRepository({ repository, artifacts: this.artifacts, accountKey, repo });
        return operation(repository);
      });
    } catch (error) {
      if (error instanceof GitError) {
        if (error.code === "git.busy") throw new DocumentError("rate.limited", { retryAfter: 2 });
        if (error.code === "git.output_too_large") throw new DocumentError("document.too_large");
        if (error.code === "git.unavailable" || error.code === "git.timeout") throw error;
        throw new DocumentError("document.integrity_failed");
      }
      throw error;
    }
  }

  /**
   * A page of first-parent history from `pinnedHead` (which must be reachable from the published
   * head), newest first, each entry checked against the commits Symplist writes.
   */
  async history(
    repo: RepoRecord,
    accountKey: AccountDataKey,
    input: { readonly pinnedHead: string; readonly skip: number; readonly limit: number },
  ): Promise<HistoryCommit[]> {
    return this.withHead(repo, accountKey, async (repository) => {
      if (
        !(await repository.hasCommit(input.pinnedHead)) ||
        !(await repository.isAncestor(input.pinnedHead, repo.headCommitId))
      ) {
        throw new DocumentError("document.resync_required");
      }
      const entries = await repository.log(input.pinnedHead, input.skip, input.limit);
      return entries.map(historyCommitFromLog);
    });
  }

  /**
   * The hunks between two published commits. Both must be reachable from the head and the baseline
   * must be an ancestor of the target; otherwise the caller must resynchronize (§9.4).
   */
  async diff(
    repo: RepoRecord,
    accountKey: AccountDataKey,
    input: { readonly base: string; readonly target: string; readonly contextLines?: number },
  ): Promise<DiffHunk[]> {
    return this.withHead(repo, accountKey, async (repository) => {
      if (
        !(await repository.hasCommit(input.base)) ||
        !(await repository.hasCommit(input.target)) ||
        !(await repository.isAncestor(input.target, repo.headCommitId)) ||
        !(await repository.isAncestor(input.base, input.target))
      ) {
        throw new DocumentError("document.resync_required");
      }
      if (input.base === input.target) return [];
      return parseUnifiedDiff(
        await repository.diff(input.base, input.target, input.contextLines ?? 3),
      );
    });
  }
}
