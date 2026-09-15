import MiniSearch, { type AsPlainObject, type Options, type SearchResult } from "minisearch";
import { chunkText } from "./chunk.ts";
import { SEARCH_LIMITS, type SearchLimits } from "./limits.ts";
import { INDEX_FORMAT_VERSION, TOKENIZER_FINGERPRINT, terms } from "./normalize.ts";
import {
  assertDocumentInput,
  assertMessageRecord,
  assertTaskRecord,
  type SearchDocumentInput,
  type SearchIndexMutator,
  type SearchMessageRecord,
  type SearchTaskRecord,
} from "./records.ts";

/** The MiniSearch fields: task titles, section headings and bodies, and the opt-in chat field set. */
export const SEARCH_FIELDS = ["title", "heading", "body", "chat"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/**
 * The MiniSearch options every index is built and loaded with. `loadJS` requires the options that
 * built the index, which is why the tokenizer fingerprint and format version are stored beside it.
 * Terms are normalized by `tokenize`, so `processTerm` passes them through. Auto vacuuming is off: the
 * writer compacts explicitly before serializing, and read-only copies never schedule timers.
 */
export const MINISEARCH_OPTIONS: Options = Object.freeze({
  idField: "id",
  fields: [...SEARCH_FIELDS],
  storeFields: [],
  tokenize: (text: string) => terms(text),
  processTerm: (term: string) => term,
  autoVacuum: false,
});

/** A section chunk as the index holds it. */
export interface SectionEntry {
  readonly docId: string;
  readonly taskId: string;
  readonly sectionId: string;
  readonly ordinal: number;
  readonly heading: string | null;
  readonly chunk: number;
  /** Offset of this chunk in the section text. */
  readonly start: number;
  readonly text: string;
  /** True when section text follows this chunk (a later chunk, or text cut at a size limit). */
  readonly more: boolean;
  readonly revision: string;
}

interface SectionMeta {
  readonly sectionId: string;
  readonly ordinal: number;
  readonly heading: string | null;
  readonly cut: boolean;
  readonly docIds: readonly string[];
  /** Indexed characters: heading plus section text (without chunk overlap). */
  readonly chars: number;
}

interface DocumentEntry {
  readonly taskId: string;
  readonly revision: string;
  readonly truncated: boolean;
  readonly sections: readonly SectionMeta[];
  readonly chars: number;
}

export type IndexDocKind = "title" | "section" | "message";

/** The kind of a MiniSearch document id. */
export function docKind(docId: string): IndexDocKind | null {
  switch (docId.charAt(0)) {
    case "t":
      return "title";
    case "s":
      return "section";
    case "m":
      return "message";
    default:
      return null;
  }
}

/** The task id inside a title or section document id. */
export function docTaskId(docId: string): string {
  return docId.slice(2, 38);
}

/** The message id inside a message document id. */
export function docMessageId(docId: string): string {
  return docId.slice(2);
}

const titleDocId = (taskId: string) => `t:${taskId}`;
const sectionDocId = (taskId: string, ordinal: number, chunk: number) =>
  `s:${taskId}:${ordinal}:${chunk}`;
const messageDocId = (messageId: string) => `m:${messageId}`;

/** The plaintext layout of a serialized index (before encryption, §4.1 object envelope). */
export interface SearchIndexArtifact {
  readonly format: "symplist.search-index";
  readonly indexFormatVersion: number;
  readonly tokenizerFingerprint: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly appliedThrough: number;
  readonly includeChat: boolean;
  /** Messages were skipped at the corpus limit (document truncation is recorded per document). */
  readonly messagesSkipped: boolean;
  readonly tasks: readonly SearchTaskRecord[];
  readonly documents: readonly {
    readonly taskId: string;
    readonly revision: string;
    readonly truncated: boolean;
    readonly sections: readonly {
      readonly sectionId: string;
      readonly ordinal: number;
      readonly heading: string | null;
      readonly cut: boolean;
      readonly chunks: readonly { readonly start: number; readonly text: string }[];
    }[];
  }[];
  readonly messages: readonly SearchMessageRecord[];
  readonly miniSearch: AsPlainObject;
}

/** A serialized index could not be used: it is rebuilt from authoritative records (§10.1). */
export class SearchIndexFormatError extends Error {
  readonly code = "search.index_unreadable";
  readonly reason:
    | "format_version"
    | "fingerprint"
    | "owner"
    | "generation"
    | "decryption"
    | "malformed";

  constructor(reason: SearchIndexFormatError["reason"]) {
    super(`The search index is unreadable (${reason})`);
    this.name = "SearchIndexFormatError";
    this.reason = reason;
  }
}

export interface SearchIndexStats {
  readonly taskCount: number;
  readonly documentCount: number;
  readonly sectionEntryCount: number;
  readonly messageCount: number;
  /** Indexed text in UTF-16 code units. */
  readonly textChars: number;
  readonly truncated: boolean;
}

/**
 * One account's search index (§10.1): a MiniSearch instance over task titles, section chunks and
 * (when opted in) chat messages, plus the records needed to filter, group and snippet results.
 * Mutations are synchronous and idempotent, and the corpus stays within {@link SEARCH_LIMITS}.
 */
export class SearchIndex implements SearchIndexMutator {
  readonly ownerId: string;
  readonly includeChat: boolean;
  private readonly limits: SearchLimits;
  private readonly miniSearch: MiniSearch;
  private readonly taskRecords = new Map<string, SearchTaskRecord>();
  private readonly documentEntries = new Map<string, DocumentEntry>();
  private readonly sectionEntries = new Map<string, SectionEntry>();
  private readonly messageRecords = new Map<string, SearchMessageRecord>();
  private readonly messagesByTask = new Map<string, Set<string>>();
  private chars = 0;
  private messagesSkipped = false;

  private constructor(
    ownerId: string,
    includeChat: boolean,
    limits: SearchLimits,
    miniSearch?: MiniSearch,
  ) {
    this.ownerId = ownerId;
    this.includeChat = includeChat;
    this.limits = limits;
    this.miniSearch = miniSearch ?? new MiniSearch(MINISEARCH_OPTIONS);
  }

  /** An empty index for an owner. `includeChat` records whether chat messages may be indexed. */
  static create(input: {
    readonly ownerId: string;
    readonly includeChat: boolean;
    readonly limits?: Partial<SearchLimits>;
  }): SearchIndex {
    return new SearchIndex(input.ownerId, input.includeChat, { ...SEARCH_LIMITS, ...input.limits });
  }

  /* ---------------------------------------------------------------------------------------------
   * Reads
   * ------------------------------------------------------------------------------------------- */

  task(taskId: string): SearchTaskRecord | undefined {
    return this.taskRecords.get(taskId);
  }

  tasks(): IterableIterator<SearchTaskRecord> {
    return this.taskRecords.values();
  }

  section(docId: string): SectionEntry | undefined {
    return this.sectionEntries.get(docId);
  }

  message(messageId: string): SearchMessageRecord | undefined {
    return this.messageRecords.get(messageId);
  }

  documentRevision(taskId: string): string | undefined {
    return this.documentEntries.get(taskId)?.revision;
  }

  /** Whether some document text or messages are missing because a size limit was reached. */
  get truncated(): boolean {
    if (this.messagesSkipped) return true;
    for (const entry of this.documentEntries.values()) if (entry.truncated) return true;
    return false;
  }

  stats(): SearchIndexStats {
    return Object.freeze({
      taskCount: this.taskRecords.size,
      documentCount: this.documentEntries.size,
      sectionEntryCount: this.sectionEntries.size,
      messageCount: this.messageRecords.size,
      textChars: this.chars,
      truncated: this.truncated,
    });
  }

  /** Runs a MiniSearch query over already normalized terms. */
  query(
    queryTerms: readonly string[],
    options: NonNullable<Parameters<MiniSearch["search"]>[1]>,
  ): SearchResult[] {
    if (queryTerms.length === 0) return [];
    return this.miniSearch.search(queryTerms.join(" "), {
      ...options,
      tokenize: (text: string) => text.split(" ").filter((term) => term.length > 0),
      processTerm: (term: string) => term,
    });
  }

  /* ---------------------------------------------------------------------------------------------
   * Mutations
   * ------------------------------------------------------------------------------------------- */

  upsertTask(task: SearchTaskRecord): void {
    assertTaskRecord(task);
    const title =
      task.title.length > this.limits.maxTitleChars
        ? task.title.slice(0, this.limits.maxTitleChars)
        : task.title;
    const record: SearchTaskRecord = Object.freeze({ ...task, title });
    const previous = this.taskRecords.get(task.id);
    const docId = titleDocId(task.id);
    if (previous) {
      this.miniSearch.discard(docId);
      this.chars -= previous.title.length;
    }
    this.taskRecords.set(task.id, record);
    this.chars += title.length;
    this.miniSearch.add({ id: docId, title });
  }

  removeTask(taskId: string): void {
    const previous = this.taskRecords.get(taskId);
    if (previous) {
      this.miniSearch.discard(titleDocId(taskId));
      this.chars -= previous.title.length;
      this.taskRecords.delete(taskId);
    }
    this.removeDocument(taskId);
    for (const messageId of [...(this.messagesByTask.get(taskId) ?? [])]) {
      this.removeMessage(messageId);
    }
  }

  replaceDocument(document: SearchDocumentInput): void {
    assertDocumentInput(document);
    this.removeDocument(document.taskId);
    const ordered = [...document.sections].sort((left, right) => left.ordinal - right.ordinal);
    let truncated = ordered.length > this.limits.maxSectionsPerDocument;
    const sections: SectionMeta[] = [];
    let documentChars = 0;
    for (const section of ordered.slice(0, this.limits.maxSectionsPerDocument)) {
      const heading =
        section.heading === null ? null : section.heading.slice(0, this.limits.maxTitleChars);
      const budget =
        Math.min(
          this.limits.maxDocumentChars - documentChars,
          this.limits.maxCorpusChars - this.chars,
        ) - (heading?.length ?? 0);
      if (budget < 0) {
        truncated = true;
        break;
      }
      const cut = section.text.length > budget;
      if (cut) truncated = true;
      const text = cut ? section.text.slice(0, budget) : section.text;
      const chunks = chunkText(text, {
        chunkChars: this.limits.chunkChars,
        overlapChars: this.limits.chunkOverlapChars,
      });
      const docIds: string[] = [];
      chunks.forEach((chunk, index) => {
        const docId = sectionDocId(document.taskId, section.ordinal, index);
        this.sectionEntries.set(
          docId,
          Object.freeze({
            docId,
            taskId: document.taskId,
            sectionId: section.sectionId,
            ordinal: section.ordinal,
            heading,
            chunk: index,
            start: chunk.start,
            text: chunk.text,
            more: index < chunks.length - 1 || cut,
            revision: document.revision,
          }),
        );
        this.miniSearch.add({ id: docId, heading: heading ?? "", body: chunk.text });
        docIds.push(docId);
      });
      const chars = text.length + (heading?.length ?? 0);
      documentChars += chars;
      this.chars += chars;
      sections.push(
        Object.freeze({
          sectionId: section.sectionId,
          ordinal: section.ordinal,
          heading,
          cut,
          docIds: Object.freeze(docIds),
          chars,
        }),
      );
      if (cut) break;
    }
    this.documentEntries.set(
      document.taskId,
      Object.freeze({
        taskId: document.taskId,
        revision: document.revision,
        truncated,
        sections: Object.freeze(sections),
        chars: documentChars,
      }),
    );
  }

  removeDocument(taskId: string): void {
    const entry = this.documentEntries.get(taskId);
    if (!entry) return;
    for (const section of entry.sections) {
      for (const docId of section.docIds) {
        this.miniSearch.discard(docId);
        this.sectionEntries.delete(docId);
      }
    }
    this.chars -= entry.chars;
    this.documentEntries.delete(taskId);
  }

  upsertMessage(message: SearchMessageRecord): void {
    assertMessageRecord(message);
    this.removeMessage(message.id);
    if (!this.includeChat) return;
    const room = this.limits.maxCorpusChars - this.chars;
    if (room <= 0) {
      this.messagesSkipped = true;
      return;
    }
    const text = message.text.slice(0, Math.min(this.limits.maxMessageChars, room));
    this.addMessageRecord(Object.freeze({ ...message, text }));
    this.miniSearch.add({ id: messageDocId(message.id), chat: text });
  }

  removeMessage(messageId: string): void {
    const previous = this.messageRecords.get(messageId);
    if (!previous) return;
    this.miniSearch.discard(messageDocId(messageId));
    this.chars -= previous.text.length;
    this.messageRecords.delete(messageId);
    const byTask = this.messagesByTask.get(previous.taskId);
    byTask?.delete(messageId);
    if (byTask?.size === 0) this.messagesByTask.delete(previous.taskId);
  }

  private addMessageRecord(record: SearchMessageRecord): void {
    this.messageRecords.set(record.id, record);
    let byTask = this.messagesByTask.get(record.taskId);
    if (!byTask) {
      byTask = new Set();
      this.messagesByTask.set(record.taskId, byTask);
    }
    byTask.add(record.id);
    this.chars += record.text.length;
  }

  /* ---------------------------------------------------------------------------------------------
   * Serialization
   * ------------------------------------------------------------------------------------------- */

  /** Removes discarded postings, so the serialized index holds live documents only. */
  async compact(): Promise<void> {
    if (this.miniSearch.dirtCount > 0) {
      await this.miniSearch.vacuum({ batchSize: 100_000, batchWait: 0 });
    }
  }

  /** The plaintext artifact for a generation. {@link compact} must run first. */
  toArtifact(meta: {
    readonly generation: number;
    readonly appliedThrough: number;
  }): SearchIndexArtifact {
    if (this.miniSearch.dirtCount > 0) {
      throw new Error("Compact the search index before serializing it");
    }
    return {
      format: "symplist.search-index",
      indexFormatVersion: INDEX_FORMAT_VERSION,
      tokenizerFingerprint: TOKENIZER_FINGERPRINT,
      ownerId: this.ownerId,
      generation: meta.generation,
      appliedThrough: meta.appliedThrough,
      includeChat: this.includeChat,
      messagesSkipped: this.messagesSkipped,
      tasks: [...this.taskRecords.values()],
      documents: [...this.documentEntries.values()].map((entry) => ({
        taskId: entry.taskId,
        revision: entry.revision,
        truncated: entry.truncated,
        sections: entry.sections.map((section) => ({
          sectionId: section.sectionId,
          ordinal: section.ordinal,
          heading: section.heading,
          cut: section.cut,
          chunks: section.docIds.map((docId) => {
            const chunk = this.sectionEntries.get(docId) as SectionEntry;
            return { start: chunk.start, text: chunk.text };
          }),
        })),
      })),
      messages: [...this.messageRecords.values()],
      miniSearch: this.miniSearch.toJSON(),
    };
  }

  /**
   * Restores an index from its artifact, checking format, tokenizer, owner, generation and internal
   * consistency. Anything wrong throws {@link SearchIndexFormatError}, which makes the caller rebuild.
   */
  static fromArtifact(
    value: unknown,
    expected: { readonly ownerId: string; readonly generation: number },
    limits?: Partial<SearchLimits>,
  ): SearchIndex {
    if (typeof value !== "object" || value === null) throw new SearchIndexFormatError("malformed");
    const artifact = value as Partial<SearchIndexArtifact>;
    if (artifact.format !== "symplist.search-index") throw new SearchIndexFormatError("malformed");
    if (artifact.indexFormatVersion !== INDEX_FORMAT_VERSION) {
      throw new SearchIndexFormatError("format_version");
    }
    if (artifact.tokenizerFingerprint !== TOKENIZER_FINGERPRINT) {
      throw new SearchIndexFormatError("fingerprint");
    }
    if (artifact.ownerId !== expected.ownerId) throw new SearchIndexFormatError("owner");
    if (artifact.generation !== expected.generation) throw new SearchIndexFormatError("generation");
    if (
      typeof artifact.includeChat !== "boolean" ||
      typeof artifact.messagesSkipped !== "boolean" ||
      !Number.isSafeInteger(artifact.appliedThrough) ||
      !Array.isArray(artifact.tasks) ||
      !Array.isArray(artifact.documents) ||
      !Array.isArray(artifact.messages) ||
      typeof artifact.miniSearch !== "object" ||
      artifact.miniSearch === null
    ) {
      throw new SearchIndexFormatError("malformed");
    }
    let miniSearch: MiniSearch;
    try {
      miniSearch = MiniSearch.loadJS(artifact.miniSearch, MINISEARCH_OPTIONS);
    } catch {
      throw new SearchIndexFormatError("malformed");
    }
    const index = new SearchIndex(
      expected.ownerId,
      artifact.includeChat,
      { ...SEARCH_LIMITS, ...limits },
      miniSearch,
    );
    try {
      index.restoreRecords(artifact as SearchIndexArtifact);
    } catch {
      throw new SearchIndexFormatError("malformed");
    }
    const records = index.taskRecords.size + index.sectionEntries.size + index.messageRecords.size;
    if (miniSearch.documentCount !== records || miniSearch.dirtCount !== 0) {
      throw new SearchIndexFormatError("malformed");
    }
    return index;
  }

  private restoreRecords(artifact: SearchIndexArtifact): void {
    this.messagesSkipped = artifact.messagesSkipped;
    for (const task of artifact.tasks) {
      assertTaskRecord(task);
      if (!this.miniSearch.has(titleDocId(task.id)) || this.taskRecords.has(task.id)) {
        throw new Error("inconsistent task");
      }
      this.taskRecords.set(task.id, Object.freeze({ ...task }));
      this.chars += task.title.length;
    }
    for (const document of artifact.documents) {
      assertDocumentInput({ taskId: document.taskId, revision: document.revision, sections: [] });
      if (!Array.isArray(document.sections) || this.documentEntries.has(document.taskId)) {
        throw new Error("inconsistent document");
      }
      const sections: SectionMeta[] = [];
      let documentChars = 0;
      for (const section of document.sections) {
        if (!Array.isArray(section.chunks) || section.chunks.length === 0) {
          throw new Error("inconsistent section");
        }
        assertDocumentInput({
          taskId: document.taskId,
          revision: document.revision,
          sections: [
            {
              sectionId: section.sectionId,
              ordinal: section.ordinal,
              heading: section.heading,
              text: "",
            },
          ],
        });
        const docIds: string[] = [];
        const chunks: readonly { readonly start: number; readonly text: string }[] = section.chunks;
        chunks.forEach((chunk, index) => {
          if (typeof chunk.text !== "string" || !Number.isSafeInteger(chunk.start)) {
            throw new Error("inconsistent chunk");
          }
          const docId = sectionDocId(document.taskId, section.ordinal, index);
          if (!this.miniSearch.has(docId)) throw new Error("missing section document");
          this.sectionEntries.set(
            docId,
            Object.freeze({
              docId,
              taskId: document.taskId,
              sectionId: section.sectionId,
              ordinal: section.ordinal,
              heading: section.heading,
              chunk: index,
              start: chunk.start,
              text: chunk.text,
              more: index < chunks.length - 1 || section.cut === true,
              revision: document.revision,
            }),
          );
          docIds.push(docId);
        });
        const last = chunks[chunks.length - 1] as { start: number; text: string };
        const chars = last.start + last.text.length + (section.heading?.length ?? 0);
        documentChars += chars;
        sections.push(
          Object.freeze({
            sectionId: section.sectionId,
            ordinal: section.ordinal,
            heading: section.heading,
            cut: section.cut === true,
            docIds: Object.freeze(docIds),
            chars,
          }),
        );
      }
      this.documentEntries.set(
        document.taskId,
        Object.freeze({
          taskId: document.taskId,
          revision: document.revision,
          truncated: document.truncated === true,
          sections: Object.freeze(sections),
          chars: documentChars,
        }),
      );
      this.chars += documentChars;
    }
    for (const message of artifact.messages) {
      assertMessageRecord(message);
      if (!this.miniSearch.has(messageDocId(message.id)) || this.messageRecords.has(message.id)) {
        throw new Error("inconsistent message");
      }
      this.addMessageRecord(Object.freeze({ ...message }));
    }
  }
}
