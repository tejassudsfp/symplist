import type { SearchCollection } from "@symplist/contracts";

/**
 * What the index stores about one task: the searchable title plus the metadata filters need. Search
 * never treats this as authoritative: results are re-read and re-authorized from D1 when rendered.
 */
export interface SearchTaskRecord {
  readonly id: string;
  readonly title: string;
  readonly collection: SearchCollection;
  readonly parentId: string | null;
  readonly archived: boolean;
  /** UTC epoch milliseconds; breaks ties between otherwise similar matches. */
  readonly updatedAt: number;
  /** `tasks.version`, so a result can tell whether the title changed since indexing. */
  readonly version: number;
}

/** One section of a document head as plain text (Markdown syntax already removed by the source). */
export interface SearchSectionInput {
  /** Opaque id from the documents feature (commit id plus structural path, §9.1). */
  readonly sectionId: string;
  /** Position of the section in the revision (0 for the preamble or first section). */
  readonly ordinal: number;
  /** Heading text, or null for a preamble without a heading. */
  readonly heading: string | null;
  readonly text: string;
}

/** The current head of one task document (§9.2). Only current heads are indexed, never history. */
export interface SearchDocumentInput {
  readonly taskId: string;
  /** Opaque head revision. */
  readonly revision: string;
  readonly sections: readonly SearchSectionInput[];
}

/** One persisted chat message of a task conversation; quick chats are never indexed (decision D1). */
export interface SearchMessageRecord {
  readonly id: string;
  readonly taskId: string;
  readonly conversationId: string;
  readonly speaker: "user" | "simon";
  readonly createdAt: number;
  readonly text: string;
}

/**
 * The mutations the index writer and the query-time overlay both apply, so pending changes are
 * interpreted identically in memory and when published (§10.1).
 */
export interface SearchIndexMutator {
  upsertTask(task: SearchTaskRecord): void;
  /** The task no longer exists: its title, document and messages leave the index. */
  removeTask(taskId: string): void;
  replaceDocument(document: SearchDocumentInput): void;
  removeDocument(taskId: string): void;
  upsertMessage(message: SearchMessageRecord): void;
  removeMessage(messageId: string): void;
}

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const collections: ReadonlySet<string> = new Set(["now", "later", "unclassified"]);
const sectionIdPattern = /^[A-Za-z0-9._:-]{1,256}$/;
const revisionPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** A record handed to the index broke its contract; nothing was changed. */
export class SearchRecordError extends Error {
  readonly code = "search.record_invalid";
  constructor(detail: string) {
    super(`Invalid search record: ${detail}`);
    this.name = "SearchRecordError";
  }
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertTaskRecord(task: SearchTaskRecord): void {
  if (!uuidV7.test(task.id)) throw new SearchRecordError("task id");
  if (typeof task.title !== "string") throw new SearchRecordError("task title");
  if (!collections.has(task.collection)) throw new SearchRecordError("task collection");
  if (task.parentId !== null && !uuidV7.test(task.parentId)) {
    throw new SearchRecordError("task parent");
  }
  if (typeof task.archived !== "boolean") throw new SearchRecordError("task archived flag");
  if (!nonNegativeInteger(task.updatedAt)) throw new SearchRecordError("task updatedAt");
  if (!nonNegativeInteger(task.version)) throw new SearchRecordError("task version");
}

export function assertDocumentInput(document: SearchDocumentInput): void {
  if (!uuidV7.test(document.taskId)) throw new SearchRecordError("document task id");
  if (!revisionPattern.test(document.revision)) throw new SearchRecordError("document revision");
  if (!Array.isArray(document.sections)) throw new SearchRecordError("document sections");
  const seen = new Set<number>();
  for (const section of document.sections) {
    if (!sectionIdPattern.test(section.sectionId)) throw new SearchRecordError("section id");
    if (!nonNegativeInteger(section.ordinal) || seen.has(section.ordinal)) {
      throw new SearchRecordError("section ordinal");
    }
    seen.add(section.ordinal);
    if (section.heading !== null && typeof section.heading !== "string") {
      throw new SearchRecordError("section heading");
    }
    if (typeof section.text !== "string") throw new SearchRecordError("section text");
  }
}

export function assertMessageRecord(message: SearchMessageRecord): void {
  if (!uuidV7.test(message.id)) throw new SearchRecordError("message id");
  if (!uuidV7.test(message.taskId)) throw new SearchRecordError("message task id");
  if (!uuidV7.test(message.conversationId)) throw new SearchRecordError("message conversation id");
  if (message.speaker !== "user" && message.speaker !== "simon") {
    throw new SearchRecordError("message speaker");
  }
  if (!nonNegativeInteger(message.createdAt)) throw new SearchRecordError("message createdAt");
  if (typeof message.text !== "string") throw new SearchRecordError("message text");
}
