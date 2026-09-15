import {
  type ArchivedTaskNode,
  type ArchiveGroup,
  type ArchiveResponse,
  pageLimitDefault,
  TASK_MAX_DEPTH,
} from "@symplist/contracts";
import type { Statement } from "@symplist/db";
import { int, sql } from "@symplist/db";
import { Temporal } from "temporal-polyfill";
import { compareSiblings, sourceKind, type TaskRecord } from "./model.ts";
import { TASK_COLUMNS } from "./sql.ts";

/** Completed tasks one archive search scans per page before returning what it found. */
export const ARCHIVE_SEARCH_SCAN = 200;

/** A malformed archive query value; the api answers `validation` on the named field. */
export class ArchiveQueryError extends Error {
  readonly code = "validation";
  readonly field: "cursor" | "timeZone";
  constructor(field: "cursor" | "timeZone") {
    super(`Invalid archive ${field}`);
    this.name = "ArchiveQueryError";
    this.field = field;
  }
}

export interface ArchiveCursor {
  readonly archivedAt: number;
  readonly id: string;
}

/** An opaque cursor for the completed task a page ended after. */
export function encodeArchiveCursor(cursor: ArchiveCursor): string {
  return Buffer.from(JSON.stringify([cursor.archivedAt, cursor.id]), "utf8").toString("base64url");
}

export function decodeArchiveCursor(value: string): ArchiveCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      (parsed[0] as number) >= 0 &&
      typeof parsed[1] === "string" &&
      /^[0-9a-f-]{36}$/.test(parsed[1])
    ) {
      return { archivedAt: parsed[0] as number, id: parsed[1] };
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ArchiveQueryError("cursor");
}

/** The canonical IANA id of a time zone, or throws when the zone is unknown. */
export function canonicalTimeZone(value: string): string {
  try {
    return Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value).timeZoneId;
  } catch {
    throw new ArchiveQueryError("timeZone");
  }
}

/** `YYYY-MM-DD` of an instant in a time zone. */
export function localDate(epochMillis: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMillis)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

/** Normalizes text for the archive filter: compatibility forms, no marks, lower case. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export interface ArchivePageInput {
  readonly ownerId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly q?: string;
  readonly timeZone?: string;
}

/** The statements that read one archive page after the key row and tree version reads. */
export function archivePageStatements(
  ownerId: string,
  cursor: ArchiveCursor | null,
  scan: number,
): Statement[] {
  const after = cursor
    ? "AND (archived_at < CAST(:cursor_at AS INTEGER) OR (archived_at = CAST(:cursor_at AS INTEGER) AND id < :cursor_id))"
    : "";
  const params = {
    owner: ownerId,
    scan: int(scan + 1),
    ...(cursor ? { cursor_at: int(cursor.archivedAt), cursor_id: cursor.id } : {}),
  };
  const roots = `SELECT id FROM tasks
    WHERE owner_id = :owner AND status = 'archived' AND archived_with_root_id = id ${after}
    ORDER BY archived_at DESC, id DESC LIMIT CAST(:scan AS INTEGER)`;
  return [
    sql(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE owner_id = :owner AND status = 'archived' AND archived_with_root_id = id ${after}
       ORDER BY archived_at DESC, id DESC LIMIT CAST(:scan AS INTEGER)`,
      params,
    ),
    sql(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE owner_id = :owner AND status = 'archived' AND archived_with_root_id <> id
         AND archived_with_root_id IN (${roots})`,
      params,
    ),
  ];
}

function archivedNode(record: TaskRecord, rootId: string, depth: number): ArchivedTaskNode {
  return {
    id: record.id,
    parentId: record.parentId,
    rootId,
    collection: record.collection,
    depth: Math.min(depth, TASK_MAX_DEPTH - 1),
    title: record.title,
    preview: record.preview,
    source: sourceKind(record.source),
    archivedAt: record.archivedAt ?? 0,
    createdAt: record.createdAt,
  } as ArchivedTaskNode;
}

/** A completed task followed by its archived subtasks in pre-order. */
function groupEntries(root: TaskRecord, members: readonly TaskRecord[]): ArchivedTaskNode[] {
  const children = new Map<string, TaskRecord[]>();
  const ids = new Set([root.id, ...members.map((member) => member.id)]);
  for (const member of members) {
    // A member whose parent is not in the group hangs under the completed task.
    const parent = member.parentId !== null && ids.has(member.parentId) ? member.parentId : root.id;
    const list = children.get(parent) ?? [];
    list.push(member);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(compareSiblings);
  const entries: ArchivedTaskNode[] = [];
  const stack: Array<{ readonly record: TaskRecord; readonly depth: number }> = [
    { record: root, depth: 0 },
  ];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const entry = stack.pop() as { readonly record: TaskRecord; readonly depth: number };
    if (seen.has(entry.record.id)) continue;
    seen.add(entry.record.id);
    entries.push(archivedNode(entry.record, root.id, entry.depth));
    const list = children.get(entry.record.id) ?? [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      stack.push({ record: list[index] as TaskRecord, depth: entry.depth + 1 });
    }
  }
  return entries;
}

/**
 * Builds an archive page (§2.1, archive brief) from the decrypted completed tasks (newest first, one
 * more than scanned when more exist) and their archived subtasks: groups by local completion date,
 * each completed task followed by its subtasks, filtered by `q` over every title in the group.
 */
export function buildArchivePage(input: {
  readonly roots: readonly TaskRecord[];
  readonly members: readonly TaskRecord[];
  readonly limit: number;
  readonly scan: number;
  readonly q: string | undefined;
  readonly timeZone: string;
  readonly taskTreeVersion: number;
}): ArchiveResponse {
  const hasMore = input.roots.length > input.scan;
  const scanned = input.roots.slice(0, input.scan);
  const membersByRoot = new Map<string, TaskRecord[]>();
  for (const member of input.members) {
    if (member.archivedWithRootId === null) continue;
    const list = membersByRoot.get(member.archivedWithRootId) ?? [];
    list.push(member);
    membersByRoot.set(member.archivedWithRootId, list);
  }
  const needle = input.q === undefined ? null : normalizeSearchText(input.q);
  const groups: ArchiveGroup[] = [];
  let included = 0;
  let lastConsidered: TaskRecord | null = null;
  let stoppedEarly = false;
  for (const root of scanned) {
    if (included >= input.limit) {
      stoppedEarly = true;
      break;
    }
    lastConsidered = root;
    const members = membersByRoot.get(root.id) ?? [];
    if (
      needle !== null &&
      ![root, ...members].some((record) => normalizeSearchText(record.title).includes(needle))
    ) {
      continue;
    }
    const date = localDate(root.archivedAt ?? 0, input.timeZone);
    const entries = groupEntries(root, members);
    const last = groups[groups.length - 1];
    if (last && last.date === date) {
      last.tasks.push(...entries);
    } else {
      groups.push({ date, tasks: entries });
    }
    included += 1;
  }
  const more = stoppedEarly || hasMore;
  return {
    taskTreeVersion: input.taskTreeVersion,
    timeZone: input.timeZone,
    groups,
    nextCursor:
      more && lastConsidered !== null
        ? encodeArchiveCursor({ archivedAt: lastConsidered.archivedAt ?? 0, id: lastConsidered.id })
        : null,
  } as ArchiveResponse;
}

/** The page size and scan window for a query. */
export function archiveWindow(input: Pick<ArchivePageInput, "limit" | "q">): {
  readonly limit: number;
  readonly scan: number;
} {
  const limit = input.limit ?? pageLimitDefault;
  return { limit, scan: input.q === undefined ? limit : Math.max(limit, ARCHIVE_SEARCH_SCAN) };
}
