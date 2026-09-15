import type { SearchCollection } from "@symplist/contracts";
import {
  type FixtureTask,
  fixtureId,
  mayaConversations,
  mayaDocuments,
  mayaTasks,
  mayaUser,
} from "@symplist/testing";
import type { SearchRunRequest } from "./rank.ts";
import type { SearchDocumentInput, SearchSectionInput, SearchTaskRecord } from "./records.ts";
import { SearchIndex } from "./search-index.ts";

/** Test support shared by this package's tests; excluded from the build. */

export const ownerId = mayaUser.id;

/**
 * A small deterministic Markdown-to-sections splitter for fixtures: ATX headings start sections, list
 * markers, task boxes, quote markers, table pipes and code fences are removed. The documents feature
 * supplies real section text from its head snapshots.
 */
export function sectionsFromMarkdown(markdown: string, revision = "rev1"): SearchSectionInput[] {
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

export function taskRecord(
  task: FixtureTask,
  overrides: Partial<SearchTaskRecord> = {},
): SearchTaskRecord {
  return {
    id: task.id,
    title: task.title,
    collection: task.collection,
    parentId: task.parentId,
    archived: task.status === "archived",
    updatedAt: task.updatedAt,
    version: 1,
    ...overrides,
  };
}

export function documentFor(
  taskId: string,
  markdown: string,
  revision = "rev1",
): SearchDocumentInput {
  return { taskId, revision, sections: sectionsFromMarkdown(markdown, revision) };
}

/** An index over Maya's tasks and documents (and messages when `includeChat`). */
export function mayaIndex(options: { readonly includeChat?: boolean } = {}): SearchIndex {
  const index = SearchIndex.create({ ownerId, includeChat: options.includeChat ?? false });
  for (const task of mayaTasks) index.upsertTask(taskRecord(task));
  for (const document of mayaDocuments) {
    index.replaceDocument(documentFor(document.taskId, document.markdown));
  }
  for (const conversation of mayaConversations) {
    if (!conversation.taskId) continue;
    for (const message of conversation.messages) {
      index.upsertMessage({
        id: message.id,
        taskId: conversation.taskId,
        conversationId: conversation.id,
        speaker: message.role === "user" ? "user" : "simon",
        createdAt: message.createdAt,
        text: message.text,
      });
    }
  }
  return index;
}

const allCollections: readonly SearchCollection[] = ["now", "later", "unclassified"];

/** A request over every active collection with titles and documents, overridable per test. */
export function request(overrides: Partial<SearchRunRequest> = {}): SearchRunRequest {
  return {
    collections: new Set(allCollections),
    archive: "exclude",
    types: new Set(["tasks", "documents"]),
    taskIds: null,
    chat: false,
    ...overrides,
  };
}

/** A fresh task id beyond the Maya fixture range. */
export function newTaskId(sequence: number): string {
  return fixtureId(0x7000 + sequence);
}

/** A task record not in the Maya fixtures. */
export function extraTask(
  sequence: number,
  title: string,
  overrides: Partial<SearchTaskRecord> = {},
): SearchTaskRecord {
  return {
    id: newTaskId(sequence),
    title,
    collection: "now",
    parentId: null,
    archived: false,
    updatedAt: 1_789_000_000_000 + sequence,
    version: 1,
    ...overrides,
  };
}
