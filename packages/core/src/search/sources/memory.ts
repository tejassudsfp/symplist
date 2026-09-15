import type { SearchDeadlineFilter } from "@symplist/contracts";
import type { AccountDataKey } from "@symplist/crypto";
import { type Statement, sql } from "@symplist/db";
import type {
  SearchDocumentInput,
  SearchMessageRecord,
  SearchSectionInput,
} from "@symplist/search";
import type {
  ChatOptInSource,
  DeadlineFilterSource,
  DocumentTextSource,
  MessageTextSource,
  SearchPage,
} from "./types.ts";

/**
 * In-memory implementations of the sources other features own, for tests of search in `core`, the api
 * and the worker while documents, Simon, preferences and scheduling are built (§2.3 fixtures). They
 * keep each owner's records apart exactly as the real sources must, and count reads so tests can
 * prove bounded access.
 */

function pageOf<Item>(
  items: readonly Item[],
  idOf: (item: Item) => string,
  page: SearchPage,
): Item[] {
  return [...items]
    .sort((left, right) => (idOf(left) < idOf(right) ? -1 : idOf(left) > idOf(right) ? 1 : 0))
    .filter((item) => page.after === null || idOf(item) > page.after)
    .slice(0, page.limit);
}

/**
 * A deterministic Markdown-to-sections splitter for fixtures: ATX headings start sections; list
 * markers, task boxes, quote markers, table pipes, emphasis marks and code fences are removed. The
 * documents feature derives real sections from its head snapshots.
 */
export function fixtureSectionsFromMarkdown(
  markdown: string,
  revision: string,
): SearchSectionInput[] {
  const sections: SearchSectionInput[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (heading === null && text.length === 0) return;
    sections.push({
      sectionId: `${revision}.s${sections.length}`,
      ordinal: sections.length,
      heading,
      text,
    });
  };
  for (const line of markdown.split("\n")) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = (match[1] ?? "").trim();
      lines = [];
      continue;
    }
    if (/^```/.test(line) || /^\s*\|?\s*-{3,}/.test(line)) continue;
    lines.push(
      line
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
        .replace(/^>\s?/, "")
        .replace(/\|/g, " ")
        .replace(/[*_`]/g, ""),
    );
  }
  flush();
  return sections;
}

/** Document heads held in memory, per owner. */
export class InMemoryDocumentTextSource implements DocumentTextSource {
  private readonly heads = new Map<string, Map<string, SearchDocumentInput>>();
  /** Task ids passed to `readHeads`, per call. */
  readonly reads: string[][] = [];
  /** When set, `readHeads` throws it (an unavailable snapshot store). */
  failure: Error | null = null;

  /** Publishes a head for a task (replacing the previous one). */
  publish(ownerId: string, document: SearchDocumentInput): void {
    let owned = this.heads.get(ownerId);
    if (!owned) {
      owned = new Map();
      this.heads.set(ownerId, owned);
    }
    owned.set(document.taskId, document);
  }

  /** Publishes Markdown as a head through {@link fixtureSectionsFromMarkdown}. */
  publishMarkdown(ownerId: string, taskId: string, markdown: string, revision: string): void {
    this.publish(ownerId, {
      taskId,
      revision,
      sections: fixtureSectionsFromMarkdown(markdown, revision),
    });
  }

  remove(ownerId: string, taskId: string): void {
    this.heads.get(ownerId)?.delete(taskId);
  }

  async listHeads(ownerId: string, page: SearchPage) {
    return pageOf([...(this.heads.get(ownerId)?.values() ?? [])], (head) => head.taskId, page).map(
      (head) => ({ taskId: head.taskId, revision: head.revision }),
    );
  }

  async readHeads(ownerId: string, taskIds: readonly string[], _key: AccountDataKey) {
    this.reads.push([...taskIds]);
    if (this.failure) throw this.failure;
    const owned = this.heads.get(ownerId);
    const found = new Map<string, SearchDocumentInput>();
    for (const taskId of taskIds) {
      const head = owned?.get(taskId);
      if (head) found.set(taskId, head);
    }
    return found;
  }

  headRevisionsStatement(ownerId: string, taskIds: readonly string[]): Statement {
    const owned = this.heads.get(ownerId);
    const rows = taskIds.flatMap((taskId) => {
      const head = owned?.get(taskId);
      return head ? [{ t: taskId, r: head.revision }] : [];
    });
    return sql(
      `SELECT json_extract(value, '$.t') AS task_id, json_extract(value, '$.r') AS revision
       FROM json_each(:heads)`,
      { heads: JSON.stringify(rows) },
    );
  }
}

/** Task-conversation messages held in memory, per owner. */
export class InMemoryMessageTextSource implements MessageTextSource {
  private readonly messages = new Map<string, Map<string, SearchMessageRecord>>();
  readonly reads: string[][] = [];

  persist(ownerId: string, message: SearchMessageRecord): void {
    let owned = this.messages.get(ownerId);
    if (!owned) {
      owned = new Map();
      this.messages.set(ownerId, owned);
    }
    owned.set(message.id, message);
  }

  remove(ownerId: string, messageId: string): void {
    this.messages.get(ownerId)?.delete(messageId);
  }

  async listMessages(ownerId: string, page: SearchPage) {
    return pageOf([...(this.messages.get(ownerId)?.keys() ?? [])], (id) => id, page);
  }

  async readMessages(ownerId: string, messageIds: readonly string[], _key: AccountDataKey) {
    this.reads.push([...messageIds]);
    const owned = this.messages.get(ownerId);
    const found = new Map<string, SearchMessageRecord>();
    for (const id of messageIds) {
      const message = owned?.get(id);
      if (message) found.set(id, message);
    }
    return found;
  }
}

/** The chat opt-in per owner; owners not listed have not opted in. */
export class InMemoryChatOptInSource implements ChatOptInSource {
  private readonly optedIn = new Set<string>();

  set(ownerId: string, include: boolean): void {
    if (include) this.optedIn.add(ownerId);
    else this.optedIn.delete(ownerId);
  }

  async includeChat(ownerId: string, _key: AccountDataKey): Promise<boolean> {
    return this.optedIn.has(ownerId);
  }
}

/** Deadline filters answered by a test-supplied function. */
export class InMemoryDeadlineFilterSource implements DeadlineFilterSource {
  readonly calls: { readonly ownerId: string; readonly filter: SearchDeadlineFilter }[] = [];

  constructor(
    private readonly match: (
      ownerId: string,
      filter: SearchDeadlineFilter,
      now: number,
    ) => Iterable<string>,
  ) {}

  async matchingTaskIds(ownerId: string, filter: SearchDeadlineFilter, now: number) {
    this.calls.push({ ownerId, filter });
    return new Set(this.match(ownerId, filter, now));
  }
}
