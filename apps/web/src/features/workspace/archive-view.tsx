"use client";

import type {
  ArchivedTaskNode,
  ArchiveGroup,
  TaskDetailResponse,
  TaskRestoreResponse,
} from "@symplist/contracts";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShellSlots } from "@/components/shell/slots";
import { Button } from "@/components/ui/button";
import { EmptyState, ThemeIllustration } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { collectionLabels, quoted } from "./commands.ts";
import { classifyFailure, type Failure, loadFailureCopy, writeFailureMessage } from "./errors.ts";
import { MAX_VISIBLE_DEPTH } from "./task-row.tsx";
import { useTaskDetail, useWorkspace } from "./workspace-provider.tsx";

/** The browser's time zone, so completion dates group the way the person experienced them. */
function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function dayLabel(date: string, today: string, yesterday: string): string {
  if (date === today) return "Today";
  if (date === yesterday) return "Yesterday";
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function isoDay(offsetDays = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

type ListStatus = "loading" | "ready" | "error";

interface ArchiveState {
  readonly status: ListStatus;
  readonly groups: readonly ArchiveGroup[];
  readonly nextCursor: string | null;
  readonly failure: Failure | null;
}

type RestoreState =
  | { readonly kind: "idle" }
  | { readonly kind: "restoring" }
  | { readonly kind: "restored"; readonly response: TaskRestoreResponse }
  | { readonly kind: "failed"; readonly failure: Failure };

export interface ArchiveViewProps {
  /** The archived record open at `/archive/[taskId]`, if any. */
  readonly taskId?: string;
}

/**
 * The archive (archive.md): completed tasks grouped by the day they were completed, keeping their
 * parent and subtask hierarchy, with a calm Restore. Selecting a record opens its retained page and
 * conversation through the shell's own seams, read only until the task is restored.
 */
export function ArchiveView({ taskId }: ArchiveViewProps) {
  const { api, tasks, commands, navigate } = useWorkspace();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<ArchiveState>({
    status: "loading",
    groups: [],
    nextCursor: null,
    failure: null,
  });
  const [restore, setRestore] = useState<RestoreState>({ kind: "idle" });
  /**
   * The open record once it is known, so it survives what takes it out of the list: a reload after
   * Restore (it is not archived any more) and a page the listing has not reached. Keyed by task id,
   * so a different record never shows the previous one for a frame.
   */
  const [known, setKnown] = useState<{
    readonly id: string;
    readonly node: ArchivedTaskNode;
  } | null>(null);
  const requestId = useRef(0);
  const timeZone = useMemo(() => localTimeZone(), []);

  const load = useCallback(
    async (options: { readonly cursor?: string; readonly q?: string } = {}) => {
      const id = ++requestId.current;
      if (!options.cursor) setState((current) => ({ ...current, status: "loading" }));
      try {
        const response = await api.listArchive({
          ...(options.cursor ? { cursor: options.cursor } : {}),
          ...(options.q ? { q: options.q } : {}),
          ...(timeZone ? { timeZone } : {}),
        });
        if (id !== requestId.current) return;
        setState((current) => ({
          status: "ready",
          groups: options.cursor ? mergeGroups(current.groups, response.groups) : response.groups,
          nextCursor: response.nextCursor,
          failure: null,
        }));
      } catch (error) {
        if (id !== requestId.current) return;
        setState((current) => ({ ...current, status: "error", failure: classifyFailure(error) }));
      }
    },
    [api, timeZone],
  );

  // A search runs after a short pause, so typing never fires a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    void load(search ? { q: search } : {});
  }, [load, search]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different record starts from no result.
  useEffect(() => {
    setRestore({ kind: "idle" });
  }, [taskId]);

  const rows = useMemo(
    () => state.groups.flatMap((group) => group.tasks.map((task) => task)),
    [state.groups],
  );

  /**
   * A record opened straight from its address is not in the first page of the listing, so the
   * archive reads the task itself as well. Without it, a link or a reload after Show more answered
   * "This task isn't available" for a task that is right there.
   */
  const detail = useTaskDetail(taskId ?? null);
  const listed = taskId ? (rows.find((task) => task.id === taskId) ?? null) : null;
  useEffect(() => {
    if (!taskId) return;
    if (listed) {
      setKnown((current) => (current?.node === listed ? current : { id: taskId, node: listed }));
      return;
    }
    const task = detail.detail?.task;
    if (!task || task.id !== taskId || task.status !== "archived") return;
    setKnown((current) =>
      current?.id === taskId ? current : { id: taskId, node: archivedNodeOf(task) },
    );
  }, [taskId, listed, detail.detail]);
  const selected = listed ?? (known !== null && known.id === taskId ? known.node : null);
  const today = isoDay();
  const yesterday = isoDay(-1);

  const onRestore = async (record: ArchivedTaskNode) => {
    setRestore({ kind: "restoring" });
    try {
      const response = await commands.restore(record.id);
      setRestore({ kind: "restored", response });
      void load(search ? { q: search } : {});
      // The task is active again, so every loaded list picks it up.
      tasks.refreshAll();
    } catch (error) {
      setRestore({ kind: "failed", failure: classifyFailure(error) });
    }
  };

  const listEmpty = state.status === "ready" && state.groups.length === 0;

  return (
    <div className="sym-archive" data-detail={taskId ? "open" : "closed"}>
      <section className="sym-archive-list" aria-labelledby="sym-archive-title">
        <div className="sym-archive-header">
          <h1 id="sym-archive-title" className="sym-archive-title">
            Archive
          </h1>
          <Link className="sym-text-button" href="/now">
            Back to Now
          </Link>
        </div>
        <input
          type="search"
          className="sym-search-input"
          aria-label="Search the archive"
          placeholder="Search completed tasks…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {state.status === "loading" && state.groups.length === 0 ? (
          <SkeletonLines label="Loading the archive" />
        ) : null}
        {state.status === "error" && state.failure ? (
          <InlineError
            {...loadFailureCopy(state.failure, "the archive")}
            onRetry={() => load(search ? { q: search } : {})}
          />
        ) : null}
        {listEmpty ? (
          search ? (
            <p className="sym-inbox-note">{`Nothing in the archive matches ${quoted(search)}.`}</p>
          ) : (
            <EmptyState
              illustration={<ThemeIllustration />}
              title="Nothing archived yet"
              description="Completed tasks land here with their page and conversation, ready to restore."
            />
          )
        ) : null}
        {state.groups.map((group) => (
          <section
            key={group.date}
            className="sym-archive-group"
            aria-label={dayLabel(group.date, today, yesterday)}
          >
            <h2 className="sym-archive-day">{dayLabel(group.date, today, yesterday)}</h2>
            <ul className="sym-archive-rows">
              {group.tasks.map((task) => (
                <li key={task.id}>
                  <Link
                    href={`/archive/${task.id}`}
                    className="sym-archive-row"
                    aria-current={task.id === taskId ? "true" : undefined}
                    style={{
                      paddingInlineStart: `${10 + Math.min(task.depth, MAX_VISIBLE_DEPTH) * 18}px`,
                    }}
                  >
                    <span className="sym-archive-row-title">{task.title}</span>
                    <span className="sym-archive-row-meta">
                      {task.depth === 0 ? collectionLabels[task.collection] : "Subtask"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {state.nextCursor ? (
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => {
              void load({
                cursor: state.nextCursor ?? undefined,
                ...(search ? { q: search } : {}),
              });
            }}
          >
            Show more
          </Button>
        ) : null}
      </section>

      {taskId ? (
        <ArchiveDetail
          taskId={taskId}
          record={selected}
          restore={restore}
          onRestore={onRestore}
          onOpenRestored={(collection) => navigate(`/${collection}/${taskId}`)}
        />
      ) : (
        <section
          className="sym-archive-detail sym-archive-detail--empty"
          aria-label="Archived task"
        >
          <EmptyState
            align="center"
            title="Pick a completed task"
            description="Its page and conversation are kept exactly as they were."
          />
        </section>
      )}
    </div>
  );
}

/** One archived task read on its own, in the shape the listing returns (its group is not read). */
function archivedNodeOf(task: TaskDetailResponse["task"]): ArchivedTaskNode {
  return {
    id: task.id,
    parentId: task.parentId,
    rootId: task.archivedWithRootId ?? task.id,
    collection: task.collection,
    depth: 0,
    title: task.title,
    preview: task.preview,
    source: task.source,
    archivedAt: task.archivedAt ?? task.updatedAt,
    createdAt: task.createdAt,
  } as ArchivedTaskNode;
}

function mergeGroups(
  current: readonly ArchiveGroup[],
  next: readonly ArchiveGroup[],
): ArchiveGroup[] {
  const merged = [...current];
  for (const group of next) {
    const index = merged.findIndex((existing) => existing.date === group.date);
    const existing = index === -1 ? undefined : merged[index];
    if (existing) merged[index] = { ...existing, tasks: [...existing.tasks, ...group.tasks] };
    else merged.push(group);
  }
  return merged;
}

function ArchiveDetail({
  taskId,
  record,
  restore,
  onRestore,
  onOpenRestored,
}: {
  readonly taskId: string;
  readonly record: ArchivedTaskNode | null;
  readonly restore: RestoreState;
  readonly onRestore: (record: ArchivedTaskNode) => void | Promise<void>;
  readonly onOpenRestored: (collection: ArchivedTaskNode["collection"]) => void;
}) {
  const slots = useShellSlots();
  const isGroupRoot = record !== null && record.rootId === record.id;

  return (
    <section className="sym-archive-detail" aria-label="Archived task">
      <div className="sym-archive-detail-header">
        <Link
          className="sym-icon-button sym-mobile-only"
          href="/archive"
          aria-label="Back to the archive"
        >
          <ChevronLeft size={18} strokeWidth={2.2} aria-hidden="true" />
        </Link>
        <div className="min-w-0 flex-1">
          <h2 className="sym-archive-detail-title">
            {record?.title ?? "This task isn't available"}
          </h2>
          <p className="sym-archive-detail-meta">
            {record
              ? `Completed · kept from ${collectionLabels[record.collection]}`
              : "It may have been restored on another device."}
          </p>
        </div>
        {record && restore.kind !== "restored" ? (
          <Button
            variant="secondary"
            size="md"
            disabled={restore.kind === "restoring"}
            aria-busy={restore.kind === "restoring" || undefined}
            onClick={() => void onRestore(record)}
          >
            {restore.kind === "restoring" ? "Restoring…" : "Restore"}
          </Button>
        ) : null}
      </div>

      {isGroupRoot ? (
        <p className="sym-archive-note">
          Restoring this task brings back the subtasks completed with it.
        </p>
      ) : null}

      {restore.kind === "restored" ? (
        <p role="status" className="sym-archive-result">
          {restoreMessage(restore.response)}{" "}
          <button
            type="button"
            className="sym-text-button"
            onClick={() => onOpenRestored(restore.response.collection)}
          >
            Open it
          </button>
        </p>
      ) : null}

      {restore.kind === "failed" ? (
        <InlineError
          title={writeFailureMessage(restore.failure, "restore this task")}
          description="Nothing changed. Its page and conversation are still here."
          onRetry={record ? () => onRestore(record) : undefined}
        />
      ) : null}

      <div className="sym-archive-panes" aria-live="off">
        <div className="sym-archive-page">
          <p className="sym-archive-readonly">Read only while this task is in the archive.</p>
          {slots.page?.(taskId)}
        </div>
        <div className="sym-archive-chat">{slots.chat?.(taskId)}</div>
      </div>
    </section>
  );
}

function restoreMessage(response: TaskRestoreResponse): string {
  const where = collectionLabels[response.collection];
  if (response.fallback === "parent_unavailable") {
    return `Restored to ${where} as a task of its own, because the task it belonged to is still completed.`;
  }
  if (response.fallback === "collection_unavailable") {
    return `Restored to ${where}, because its old list is no longer there.`;
  }
  const count = response.restoredTaskIds.length;
  return count > 1
    ? `Restored to ${where} with ${count - 1} subtask${count === 2 ? "" : "s"}.`
    : `Restored to ${where}.`;
}
