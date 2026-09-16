import type { SearchDeadlineFilter } from "@symplist/contracts";
import type { AccountDataKey, KeyProvider } from "@symplist/crypto";
import type { DbClient, DbRow, Statement } from "@symplist/db";
import type { SearchDocumentInput, SearchMessageRecord, SearchTaskRecord } from "@symplist/search";
import type { ObjectStore } from "@symplist/storage";
import type { CoreDomain } from "../../domains.ts";

/**
 * Authoritative content the index is built from (§10.1). Search is a derived index: it reads task
 * rows directly, and document heads, chat messages, the chat opt-in and schedule metadata through
 * these interfaces, which the owning features implement. Every method is scoped to one owner and never
 * returns another owner's data.
 */

/** Paging through an owner's records in id order. */
export interface SearchPage {
  /** Return records with ids greater than this; null starts at the beginning. */
  readonly after: string | null;
  readonly limit: number;
}

/** Task titles and metadata, read from `tasks` by SQL (owned by search, §2.1 columns). */
export interface SearchTaskSource {
  /** The owner's tasks among `taskIds`, decrypted; ids that are not the owner's tasks are absent. */
  readTasks(
    ownerId: string,
    taskIds: readonly string[],
    key: AccountDataKey,
  ): Promise<ReadonlyMap<string, SearchTaskRecord>>;
  /** Every task of the owner (active and archived), in id order. */
  listTasks(
    ownerId: string,
    page: SearchPage,
    key: AccountDataKey,
  ): Promise<readonly SearchTaskRecord[]>;
  /**
   * Read-only statements returning the owner's rows for `taskIds` and for their parents, to fold into
   * the rendering batch; decode their rows with `tasksFromRows`.
   */
  renderStatements(ownerId: string, taskIds: readonly string[]): readonly Statement[];
  tasksFromRows(
    ownerId: string,
    rows: readonly DbRow[],
    key: AccountDataKey,
  ): ReadonlyMap<string, SearchTaskRecord>;
}

/** The documents feature's current heads, from immutable head snapshots (§9.2). */
export interface DocumentTextSource {
  /** Tasks of the owner that have a published head, in task id order. */
  listHeads(
    ownerId: string,
    page: SearchPage,
  ): Promise<readonly { readonly taskId: string; readonly revision: string }[]>;
  /**
   * The current heads of the owner's tasks among `taskIds` as plain-text sections (Markdown syntax
   * removed). Tasks without a head are absent.
   */
  readHeads(
    ownerId: string,
    taskIds: readonly string[],
    key: AccountDataKey,
  ): Promise<ReadonlyMap<string, SearchDocumentInput>>;
  /**
   * One read-only statement returning a `task_id` and a `revision` column for each of the owner's
   * current heads among `taskIds` (at most 50 ids), folded into the rendering batch (§10.1
   * `indexedRevision` against the current head).
   */
  headRevisionsStatement(ownerId: string, taskIds: readonly string[]): Statement;
}

/** Simon's persisted task-conversation messages; quick chats are never returned (decision D1). */
export interface MessageTextSource {
  /** Ids of the owner's task-conversation messages, in id order. */
  listMessages(ownerId: string, page: SearchPage): Promise<readonly string[]>;
  readMessages(
    ownerId: string,
    messageIds: readonly string[],
    key: AccountDataKey,
  ): Promise<ReadonlyMap<string, SearchMessageRecord>>;
}

/** The owner's `privacy` preference: whether chat content may enter search (§10.1, §10.3). */
export interface ChatOptInSource {
  includeChat(ownerId: string, key: AccountDataKey): Promise<boolean>;
}

/** Schedule metadata for deadline filters (note 14, note 15); never derived from the index. */
export interface DeadlineFilterSource {
  /** The owner's task ids whose schedule satisfies the filter at `now`. */
  matchingTaskIds(
    ownerId: string,
    filter: SearchDeadlineFilter,
    now: number,
  ): Promise<ReadonlySet<string>>;
}

/** Every source a search runtime uses. Absent optional sources mean that content does not exist yet. */
export interface SearchSources {
  readonly tasks: SearchTaskSource;
  readonly documents: DocumentTextSource | null;
  readonly messages: MessageTextSource | null;
  readonly chatOptIn: ChatOptInSource | null;
  readonly deadlines: DeadlineFilterSource | null;
}

/** What a source is built with, in the api and in the worker. */
export interface SearchSourceDependencies {
  readonly db: DbClient;
  readonly objects: ObjectStore;
  readonly keys: KeyProvider;
}

/**
 * A domain's contribution of search sources (§2.3). The documents feature supplies `documents`, Simon
 * `messages`, preferences `chatOptIn` and scheduling `deadlines`; each is a plain factory, so the api and
 * the worker build identical sources without Nest.
 */
export interface SearchSourceContributor {
  readonly domain: CoreDomain;
  readonly documents?: (dependencies: SearchSourceDependencies) => DocumentTextSource;
  readonly messages?: (dependencies: SearchSourceDependencies) => MessageTextSource;
  readonly chatOptIn?: (dependencies: SearchSourceDependencies) => ChatOptInSource;
  readonly deadlines?: (dependencies: SearchSourceDependencies) => DeadlineFilterSource;
}
