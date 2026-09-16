import type { WorkerConfig } from "@symplist/config/worker";
import {
  DOCUMENT_HEAD_CHANGED_EVENT,
  DocumentMaintenance,
  type DocumentMaintenanceResult,
  DocumentRepository,
  DocumentTools,
  headChangedPayload,
  runDocumentGitJob,
} from "@symplist/core/documents";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient } from "@symplist/db";
import { GitService } from "@symplist/docs";
import type { ObjectStore } from "@symplist/storage";
import type { InternalEventClient } from "../../infra/internal-events.ts";
import type { WorkerLogger } from "../../infra/logger.ts";

/** What the documents tasks need from the worker runtime; tests pass local drivers. */
export interface DocumentWorkerDependencies {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly keys: KeyProvider;
  readonly logger: WorkerLogger;
  readonly events: Pick<InternalEventClient, "announce">;
  readonly config: Pick<WorkerConfig, "GIT_TMP_DIR" | "DOC_MAX_BYTES" | "BETA_ACCESS_REQUIRED">;
  readonly now?: () => number;
}

export interface DocumentWorker {
  readonly repository: DocumentRepository;
  readonly tools: DocumentTools;
  readonly maintenance: DocumentMaintenance;
  readonly git: GitService;
  readonly now: () => number;
}

/**
 * The document services in a worker process (§9.1): the same repository, tools and Git service the
 * api uses, with one reconstruction at a time per task process (the `d1-git` queue bounds processes)
 * and head changes announced to the api as signed, ids-only internal events (§6.2).
 */
export function createDocumentWorker(dependencies: DocumentWorkerDependencies): DocumentWorker {
  const now = dependencies.now ?? (() => Date.now());
  const git = new GitService({
    tempDir: dependencies.config.GIT_TMP_DIR,
    limits: { maxConcurrent: 1, maxQueued: 4, maxBlobBytes: dependencies.config.DOC_MAX_BYTES },
  });
  const repository = new DocumentRepository({
    db: dependencies.db,
    objects: dependencies.objects,
    keys: dependencies.keys,
    git,
    accessPolicy: { betaAccessRequired: dependencies.config.BETA_ACCESS_REQUIRED },
    now,
    docMaxBytes: dependencies.config.DOC_MAX_BYTES,
    events: {
      headChanged: async (event) => {
        const outcome = await dependencies.events.announce({
          type: DOCUMENT_HEAD_CHANGED_EVENT,
          ownerId: event.ownerId,
          payload: {
            ...headChangedPayload(event),
            changedSectionIds: [...event.changedSectionIds.slice(0, 100)],
          },
        });
        if (outcome !== "delivered") {
          dependencies.logger.warn("documents.head_changed_not_delivered", {
            taskId: event.taskId,
            status: outcome,
          });
        }
      },
      onError: (error) => {
        dependencies.logger.warn("documents.head_changed_failed", {
          code:
            typeof (error as { code?: unknown })?.code === "string"
              ? (error as { code: string }).code
              : "internal.error",
        });
      },
    },
  });
  return {
    repository,
    tools: new DocumentTools(repository),
    maintenance: new DocumentMaintenance({
      db: dependencies.db,
      objects: dependencies.objects,
      git,
    }),
    git,
    now,
  };
}

/**
 * The body of `document-git` (§8.8): sweeps workspaces a crashed attempt left behind in this
 * process's temp root, then runs the job. Returns ids and codes only (§8.3).
 */
export async function runDocumentGitTask(
  payload: unknown,
  worker: DocumentWorker,
): Promise<{ readonly status: "completed" | "failed"; readonly code: string | null }> {
  await worker.git.sweepStaleWorkspaces(worker.now());
  return runDocumentGitJob({
    payload,
    db: worker.repository.db,
    accountKeys: worker.repository.accountKeys,
    artifacts: worker.repository.artifacts,
    tools: worker.tools,
    now: worker.now,
  });
}

/**
 * The body of `documents-maintenance`: bounded passes over every owner page in id order (a task
 * process keeps no cursor between runs), stopping after `maxPasses`. Counts only in the result.
 */
export async function runDocumentsMaintenanceTask(
  worker: DocumentWorker,
  options: { readonly maxPasses?: number } = {},
): Promise<{
  readonly deletedBundles: number;
  readonly deletedSnapshots: number;
  readonly deletedJobs: number;
  readonly expiredRequests: number;
  readonly expiredReceipts: number;
  readonly staleWorkspaces: number;
  readonly passes: number;
  readonly complete: boolean;
}> {
  const totals = {
    deletedBundles: 0,
    deletedSnapshots: 0,
    deletedJobs: 0,
    expiredRequests: 0,
    expiredReceipts: 0,
    staleWorkspaces: 0,
    passes: 0,
    complete: true,
  };
  let cursor: string | null = null;
  const maxPasses = options.maxPasses ?? 40;
  do {
    const result: DocumentMaintenanceResult = await worker.maintenance.run({
      now: worker.now(),
      afterOwnerId: cursor,
    });
    totals.passes += 1;
    totals.deletedBundles += result.orphans.deletedBundles;
    totals.deletedSnapshots += result.orphans.deletedSnapshots;
    totals.deletedJobs += result.orphans.deletedJobs;
    totals.expiredRequests += result.expiredRequests;
    totals.expiredReceipts += result.expiredReceipts;
    totals.staleWorkspaces += result.staleWorkspaces;
    totals.complete &&= result.orphans.complete;
    cursor = result.nextOwnerId;
  } while (cursor !== null && totals.passes < maxPasses);
  return { ...totals, complete: totals.complete && cursor === null };
}
