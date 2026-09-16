"use client";

import type { TaskCollection } from "@symplist/contracts";
import { Plus, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { EmptyState, ThemeIllustration } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { collectionLabels } from "./commands.ts";
import { QUICK_ADD_ID } from "./controller.ts";
import { TaskDragProvider } from "./dnd.tsx";
import { loadFailureCopy } from "./errors.ts";
import { TaskRow } from "./task-row.tsx";
import { visibleRows } from "./tree.ts";
import { useTaskCollection, useWorkspace, useWorkspaceUi } from "./workspace-provider.tsx";

/** The empty state each collection shows, in its own voice (the three inbox briefs). */
const emptyCopy: Readonly<Record<TaskCollection, { title: string; description: string }>> = {
  now: {
    title: "Nothing here yet",
    description: "Add a task above and press Enter.",
  },
  later: {
    title: "A place for things you can come back to",
    description: "Add something here, or drag a task over from Now.",
  },
  unclassified: {
    title: "Drop a thought here",
    description: "Sort it when you're ready — nothing here needs a decision today.",
  },
};

export interface TaskInboxProps {
  readonly collection: TaskCollection;
}

/**
 * The task list for one collection (workspace_now.md, workspace_later.md, workspace_unclassified.md):
 * quiet search, quick add, and the task tree with its sublists, drag and drop, and per-row menu. It is
 * the shell's `inbox` slot, so the panel frame, its heading and the collection tabs stay with the shell.
 */
export function TaskInbox({ collection }: TaskInboxProps) {
  const { tasks, ui, commands } = useWorkspace();
  const snapshot = useTaskCollection(collection);
  const draft = useWorkspaceUi((state) => state.drafts[collection]);
  const searchOpen = useWorkspaceUi((state) => state.searchOpen[collection]);
  const query = useWorkspaceUi((state) => state.queries[collection]);
  const expanded = useWorkspaceUi((state) => state.expanded);
  const subDraft = useWorkspaceUi((state) => state.subDraft);
  const adding = useWorkspaceUi((state) =>
    [...state.pending].some((scope) => scope.startsWith(`create:${collection}:`)),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scrollTops = useRef(new Map<TaskCollection, number>());

  const rows = useMemo(
    () => visibleRows(snapshot.tasks, expanded, searchOpen ? query : ""),
    [snapshot.tasks, expanded, searchOpen, query],
  );

  // The list keeps its place per collection, including a return from a task on a phone.
  useLayoutEffect(() => {
    const element = rootRef.current?.closest<HTMLElement>(".sym-panel-body") ?? null;
    if (!element) return;
    element.scrollTop = scrollTops.current.get(collection) ?? 0;
    const onScroll = () => scrollTops.current.set(collection, element.scrollTop);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [collection]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const label = collectionLabels[collection];
  const listStatus = snapshot.status;
  const isEmpty = listStatus === "ready" && snapshot.tasks.length === 0;
  const noMatches = searchOpen && query.trim().length > 0 && rows.length === 0 && !isEmpty;

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && draft.trim().length === 0) {
      event.preventDefault();
      ui.setDraft(collection, "");
      event.currentTarget.blur();
    }
  };

  return (
    <div className="sym-inbox-content" ref={rootRef}>
      <div className="sym-inbox-tools">
        <form
          className="sym-quick-add"
          data-busy={adding || undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void commands.addTask(collection);
          }}
        >
          <Plus size={14} strokeWidth={2.2} aria-hidden="true" className="text-sym-faint" />
          <input
            id={QUICK_ADD_ID}
            className="sym-quick-add-input"
            aria-label={`Add task to ${label}`}
            placeholder="Add task"
            value={draft}
            readOnly={adding}
            autoComplete="off"
            onChange={(event) => ui.setDraft(collection, event.target.value)}
            onKeyDown={onDraftKeyDown}
          />
          {adding ? <Spinner size={12} label="Adding" /> : null}
          {draft.trim().length > 0 && !adding ? (
            <span aria-hidden="true" className="sym-kbd">
              ↵
            </span>
          ) : null}
        </form>
        <button
          type="button"
          className="sym-icon-button"
          aria-label={searchOpen ? `Close search in ${label}` : `Search ${label}`}
          aria-pressed={searchOpen}
          onClick={() => ui.setSearchOpen(collection, !searchOpen)}
        >
          {searchOpen ? (
            <X size={15} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Search size={15} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      </div>
      {searchOpen ? (
        <div className="sym-inbox-search">
          <input
            ref={searchRef}
            type="search"
            className="sym-search-input"
            aria-label={`Search ${label}`}
            placeholder={`Search ${label}…`}
            value={query}
            onChange={(event) => ui.setQuery(collection, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                ui.setSearchOpen(collection, false);
              }
            }}
          />
        </div>
      ) : null}

      {listStatus === "loading" && snapshot.tasks.length === 0 ? (
        <SkeletonLines label={`Loading ${label}`} />
      ) : null}

      {listStatus === "error" && snapshot.failure ? (
        <InlineError
          {...loadFailureCopy(snapshot.failure, label)}
          onRetry={() => tasks.refresh(collection)}
        />
      ) : null}

      {isEmpty ? (
        <EmptyState
          illustration={<ThemeIllustration />}
          title={emptyCopy[collection].title}
          description={emptyCopy[collection].description}
        />
      ) : null}

      {snapshot.tasks.length > 0 ? (
        <TaskDragProvider collection={collection}>
          <div role="tree" aria-label={`${label} tasks`} className="sym-task-tree">
            {rows.map((row) => (
              <TaskRowWithDraft
                key={row.task.id}
                collection={collection}
                row={row}
                subDraftFor={subDraft?.parentId === row.task.id ? subDraft.text : null}
              />
            ))}
          </div>
        </TaskDragProvider>
      ) : null}

      {noMatches ? (
        <p className="sym-inbox-note">{`No tasks in ${label} match “${query.trim()}”.`}</p>
      ) : null}
    </div>
  );
}

function TaskRowWithDraft({
  row,
  collection,
  subDraftFor,
}: {
  readonly row: ReturnType<typeof visibleRows>[number];
  readonly collection: TaskCollection;
  readonly subDraftFor: string | null;
}) {
  const { ui, commands } = useWorkspace();
  const pending = useWorkspaceUi((state) =>
    [...state.pending].some((scope) => scope.startsWith(`create:${row.task.id}:`)),
  );
  const draftRef = useRef<HTMLInputElement | null>(null);
  const open = subDraftFor !== null;

  // Add subtask is an explicit request to type one, so the field takes focus when it opens.
  useEffect(() => {
    if (open) draftRef.current?.focus();
  }, [open]);

  return (
    <>
      <TaskRow
        task={row.task}
        collection={collection}
        expanded={row.expanded}
        matched={row.matched}
        posInSet={row.posInSet}
        setSize={row.setSize}
      />
      {subDraftFor === null ? null : (
        // A `fieldset` is the tree's `group`: `role="tree"` only admits treeitems and groups, so the
        // draft field has to sit inside one to keep the list's ARIA structure valid.
        <fieldset
          className="sym-subtask-group"
          aria-label={`Add a subtask under ${row.task.title}`}
        >
          <form
            className="sym-subtask-add"
            style={{ marginInlineStart: `${24 + Math.min(row.task.depth, 2) * 18}px` }}
            onSubmit={(event) => {
              event.preventDefault();
              void commands.addSubtask();
            }}
          >
            <Plus size={12} strokeWidth={2.2} aria-hidden="true" className="text-sym-faint" />
            <input
              ref={draftRef}
              className="sym-quick-add-input"
              aria-label={`Add subtask under ${row.task.title}`}
              placeholder="Add subtask"
              value={subDraftFor}
              readOnly={pending}
              autoComplete="off"
              onChange={(event) => ui.setSubDraft(row.task.id, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  ui.setSubDraft(null);
                  ui.requestFocus(row.task.id);
                }
              }}
              onBlur={() => {
                if (subDraftFor.trim().length === 0) ui.setSubDraft(null);
              }}
            />
            {pending ? <Spinner size={12} label="Adding" /> : null}
          </form>
        </fieldset>
      )}
    </>
  );
}
