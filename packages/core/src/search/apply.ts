import type { AccountDataKey } from "@symplist/crypto";
import type { SearchIndexMutator } from "@symplist/search";
import type { CoalescedIntents } from "./intents.ts";
import type { SearchSources } from "./sources/types.ts";

export interface ApplyIntentsInput {
  readonly ownerId: string;
  readonly key: AccountDataKey;
  readonly sources: SearchSources;
  /** Documents re-read at most (the query-time overlay is bounded; the writer passes no bound). */
  readonly maxDocuments?: number;
}

export interface ApplyIntentsResult {
  readonly tasks: number;
  readonly documents: number;
  /** Changes that were not applied because a bound was reached. */
  readonly deferred: number;
}

/**
 * Applies coalesced intents to an index or an overlay (§10.1). Every upsert re-reads the current
 * authoritative record through the sources, so a stale or repeated intent can never resurrect old
 * content: a task or head that no longer exists is removed.
 */
export async function applyIntents(
  mutator: SearchIndexMutator,
  intents: CoalescedIntents,
  input: ApplyIntentsInput,
): Promise<ApplyIntentsResult> {
  const { ownerId, key, sources } = input;
  let deferred = 0;

  const taskUpserts: string[] = [];
  for (const [taskId, op] of intents.tasks) {
    if (op === "delete") mutator.removeTask(taskId);
    else taskUpserts.push(taskId);
  }
  if (taskUpserts.length > 0) {
    const found = await sources.tasks.readTasks(ownerId, taskUpserts, key);
    for (const taskId of taskUpserts) {
      const task = found.get(taskId);
      if (task) mutator.upsertTask(task);
      else mutator.removeTask(taskId);
    }
  }

  let documentUpserts: string[] = [];
  for (const [taskId, op] of intents.documents) {
    if (op === "delete") mutator.removeDocument(taskId);
    else documentUpserts.push(taskId);
  }
  if (input.maxDocuments !== undefined && documentUpserts.length > input.maxDocuments) {
    deferred += documentUpserts.length - input.maxDocuments;
    documentUpserts = documentUpserts.slice(0, input.maxDocuments);
  }
  if (documentUpserts.length > 0) {
    if (sources.documents) {
      const heads = await sources.documents.readHeads(ownerId, documentUpserts, key);
      for (const taskId of documentUpserts) {
        const head = heads.get(taskId);
        if (head) mutator.replaceDocument(head);
        else mutator.removeDocument(taskId);
      }
    } else {
      for (const taskId of documentUpserts) mutator.removeDocument(taskId);
    }
  }

  return { tasks: intents.tasks.size, documents: intents.documents.size, deferred };
}

/** Reads every authoritative record of an owner into an empty index (a rebuild, §10.1). */
export async function loadAllRecords(
  mutator: SearchIndexMutator,
  input: Omit<ApplyIntentsInput, "maxDocuments"> & {
    readonly pageSize?: number;
    /** Stops reading documents (titles only), for the query-time fallback. */
    readonly titlesOnly?: boolean;
    /** Tasks read at most; beyond it the result reports `complete: false`. */
    readonly maxTasks?: number;
    readonly signal?: AbortSignal;
  },
): Promise<{
  readonly tasks: number;
  readonly documents: number;
  readonly complete: boolean;
}> {
  const { ownerId, key, sources } = input;
  // Every feature-owned source has the same bounded 100-row cursor contract. Keeping the rebuild
  // page at that ceiling is essential: a source must never return a smaller capped page that looks
  // like the end of its corpus to the generic loop.
  const pageSize = input.pageSize ?? 100;
  let tasks = 0;
  let documents = 0;
  let complete = true;

  for (let after: string | null = null; ; ) {
    input.signal?.throwIfAborted();
    const page = await sources.tasks.listTasks(ownerId, { after, limit: pageSize }, key);
    for (const task of page) {
      if (input.maxTasks !== undefined && tasks >= input.maxTasks) {
        complete = false;
        break;
      }
      mutator.upsertTask(task);
      tasks += 1;
    }
    if (!complete || page.length < pageSize) break;
    after = (page[page.length - 1] as { id: string }).id;
  }
  if (input.titlesOnly) return { tasks, documents, complete };

  if (sources.documents) {
    for (let after: string | null = null; ; ) {
      input.signal?.throwIfAborted();
      const heads = await sources.documents.listHeads(ownerId, { after, limit: pageSize });
      if (heads.length > 0) {
        const read = await sources.documents.readHeads(
          ownerId,
          heads.map((head) => head.taskId),
          key,
        );
        for (const head of read.values()) {
          mutator.replaceDocument(head);
          documents += 1;
        }
      }
      if (heads.length < pageSize) break;
      after = (heads[heads.length - 1] as { taskId: string }).taskId;
    }
  }
  return { tasks, documents, complete };
}
