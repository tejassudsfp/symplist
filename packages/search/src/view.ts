import type { SearchLimits } from "./limits.ts";
import type {
  SearchDocumentInput,
  SearchIndexMutator,
  SearchMessageRecord,
  SearchTaskRecord,
} from "./records.ts";
import { docKind, docMessageId, docTaskId, SearchIndex } from "./search-index.ts";

/** Base-index entries hidden because the overlay holds a newer state of them. */
export interface SearchShadow {
  /** Tasks whose title and metadata come from the overlay (or that no longer exist). */
  readonly tasks: ReadonlySet<string>;
  /** Tasks that no longer exist: their base documents and messages are hidden too. */
  readonly deletedTasks: ReadonlySet<string>;
  /** Tasks whose base document is replaced or removed by the overlay. */
  readonly documents: ReadonlySet<string>;
  /** Messages replaced or removed by the overlay. */
  readonly messages: ReadonlySet<string>;
}

/** One index a search runs over, with the rule deciding which of its documents are current. */
export interface SearchLayer {
  readonly index: SearchIndex;
  visible(docId: string): boolean;
}

const emptyShadow: SearchShadow = Object.freeze({
  tasks: new Set<string>(),
  deletedTasks: new Set<string>(),
  documents: new Set<string>(),
  messages: new Set<string>(),
});

/**
 * What a query runs against (§10.1): the published index for a generation, optionally with an
 * in-memory overlay of changes committed after it (the api never writes the index in durable mode, so
 * it applies unindexed intents only in memory). With no published index, the overlay alone serves
 * title results while the index is rebuilt.
 */
export class SearchView {
  readonly base: SearchIndex | null;
  readonly overlay: SearchIndex | null;
  readonly shadow: SearchShadow;

  constructor(base: SearchIndex | null, overlay: SearchIndex | null, shadow: SearchShadow) {
    if (!base && !overlay) throw new Error("A search view needs an index");
    this.base = base;
    this.overlay = overlay;
    this.shadow = shadow;
  }

  /** A view over one index with nothing shadowed. */
  static of(index: SearchIndex): SearchView {
    return new SearchView(index, null, emptyShadow);
  }

  get ownerId(): string {
    return (this.base ?? (this.overlay as SearchIndex)).ownerId;
  }

  /** Whether the published index (or the overlay alone) may contain chat messages. */
  get includesChat(): boolean {
    return (this.base ?? (this.overlay as SearchIndex)).includeChat;
  }

  /** Whether some content is missing because of a size limit. */
  get truncated(): boolean {
    return (this.base?.truncated ?? false) || (this.overlay?.truncated ?? false);
  }

  /** The current record of a task, preferring the overlay. */
  task(taskId: string): SearchTaskRecord | undefined {
    const fromOverlay = this.overlay?.task(taskId);
    if (fromOverlay) return fromOverlay;
    if (this.shadow.tasks.has(taskId) || this.shadow.deletedTasks.has(taskId)) return undefined;
    return this.base?.task(taskId);
  }

  /** Every current task record, overlay first. */
  *tasks(): IterableIterator<SearchTaskRecord> {
    const seen = new Set<string>();
    for (const task of this.overlay?.tasks() ?? []) {
      seen.add(task.id);
      yield task;
    }
    for (const task of this.base?.tasks() ?? []) {
      if (seen.has(task.id) || this.shadow.tasks.has(task.id)) continue;
      if (this.shadow.deletedTasks.has(task.id)) continue;
      yield task;
    }
  }

  layers(): readonly SearchLayer[] {
    const layers: SearchLayer[] = [];
    const { base, overlay, shadow } = this;
    if (base) {
      layers.push({
        index: base,
        visible: (docId) => {
          switch (docKind(docId)) {
            case "title": {
              const taskId = docTaskId(docId);
              return !shadow.tasks.has(taskId) && !shadow.deletedTasks.has(taskId);
            }
            case "section": {
              const taskId = docTaskId(docId);
              return !shadow.documents.has(taskId) && !shadow.deletedTasks.has(taskId);
            }
            case "message": {
              const messageId = docMessageId(docId);
              const record = base.message(messageId);
              return (
                record !== undefined &&
                !shadow.messages.has(messageId) &&
                !shadow.deletedTasks.has(record.taskId)
              );
            }
            default:
              return false;
          }
        },
      });
    }
    if (overlay) layers.push({ index: overlay, visible: () => true });
    return layers;
  }
}

/**
 * Builds a {@link SearchView} from a published index and the changes committed after it, applying
 * them with the same mutations the writer uses, into a small overlay index that shadows the base.
 */
export class SearchOverlayBuilder implements SearchIndexMutator {
  private readonly overlay: SearchIndex;
  private readonly shadowTasks = new Set<string>();
  private readonly deletedTasks = new Set<string>();
  private readonly shadowDocuments = new Set<string>();
  private readonly shadowMessages = new Set<string>();

  constructor(
    private readonly base: SearchIndex | null,
    input: {
      readonly ownerId: string;
      readonly includeChat: boolean;
      readonly limits?: Partial<SearchLimits>;
    },
  ) {
    if (base && base.ownerId !== input.ownerId) {
      throw new Error("The overlay and the published index belong to different owners");
    }
    this.overlay = SearchIndex.create(input);
  }

  upsertTask(task: SearchTaskRecord): void {
    this.deletedTasks.delete(task.id);
    this.shadowTasks.add(task.id);
    this.overlay.upsertTask(task);
  }

  removeTask(taskId: string): void {
    this.shadowTasks.add(taskId);
    this.deletedTasks.add(taskId);
    this.shadowDocuments.add(taskId);
    this.overlay.removeTask(taskId);
  }

  replaceDocument(document: SearchDocumentInput): void {
    this.shadowDocuments.add(document.taskId);
    this.overlay.replaceDocument(document);
  }

  removeDocument(taskId: string): void {
    this.shadowDocuments.add(taskId);
    this.overlay.removeDocument(taskId);
  }

  upsertMessage(message: SearchMessageRecord): void {
    this.shadowMessages.add(message.id);
    this.overlay.upsertMessage(message);
  }

  removeMessage(messageId: string): void {
    this.shadowMessages.add(messageId);
    this.overlay.removeMessage(messageId);
  }

  /** Whether any change was applied. */
  get changed(): boolean {
    return (
      this.shadowTasks.size + this.shadowDocuments.size + this.shadowMessages.size > 0 ||
      this.overlay.stats().taskCount > 0
    );
  }

  /** Characters held by the overlay, for cache accounting. */
  get overlayChars(): number {
    return this.overlay.stats().textChars;
  }

  view(): SearchView {
    return new SearchView(this.base, this.overlay, {
      tasks: new Set(this.shadowTasks),
      deletedTasks: new Set(this.deletedTasks),
      documents: new Set(this.shadowDocuments),
      messages: new Set(this.shadowMessages),
    });
  }
}
