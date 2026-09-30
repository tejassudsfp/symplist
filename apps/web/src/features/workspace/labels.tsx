"use client";

import type { LabelColour, LabelView, TaskCollection } from "@symplist/contracts";
import { LABEL_MAX_PER_TASK } from "@symplist/contracts";
import { Check, Tag, X } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { accentPresets } from "@/theme/accent";
import {
  useLoadedTaskCollection,
  useTaskCollection,
  useWorkspace,
  useWorkspaceUi,
} from "./workspace-provider.tsx";

/** The CSS variable holding a label colour's 3:1 fill, emitted per theme and mode by `theme/css.ts`. */
export function labelColorVariable(colour: LabelColour): string {
  return `var(--sym-label-${colour})`;
}

/** A label's colour as a person names it in the picker, from the accent palette it is drawn from. */
export function labelColourName(colour: LabelColour): string {
  return accentPresets[colour].label;
}

/**
 * One label, drawn as a small dot in its colour beside its name.
 *
 * A dot rather than a coloured pill: the name stays in the theme's own text colour, so it is as legible
 * as any other row in any of the six themes, light or dark, and eight labels on screen read as a list
 * rather than as eight competing highlights. The dot is decorative — the name carries the meaning — so
 * it is hidden from assistive technology.
 */
export function LabelChip({ label }: { readonly label: LabelView }) {
  return (
    <span className="sym-label-chip">
      <span
        aria-hidden="true"
        className="sym-label-dot"
        style={{ background: labelColorVariable(label.colour) }}
      />
      {label.name}
    </span>
  );
}

/** The chips a task row shows, in the owner's label order. */
export function TaskRowLabels({
  collection,
  labelIds,
}: {
  readonly collection: TaskCollection;
  readonly labelIds: readonly string[];
}) {
  const { labels } = useLoadedTaskCollection(collection);
  if (labelIds.length === 0) return null;
  const shown = labels.filter((label) => labelIds.includes(label.id));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
    </>
  );
}

/**
 * The chips a task's own page shows.
 *
 * The detail response does not carry them — it is one task, not a tree — so they come from the
 * collection's tree as it is already loaded. Loading it for these would spend a request on decoration:
 * every surface a person reaches a task through has the list loaded already, and on a cold direct link
 * the chips simply arrive with it.
 */
export function TaskHeaderLabels({
  collection,
  taskId,
}: {
  readonly collection: TaskCollection;
  readonly taskId: string;
}) {
  const snapshot = useLoadedTaskCollection(collection);
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return null;
  return <TaskRowLabels collection={collection} labelIds={task.labelIds} />;
}

/**
 * The task menu's Labels page: every label with a tick beside the ones this task carries.
 *
 * It lists the account's labels rather than offering a field to type one, because a label is a word
 * reused across the list — inventing one from a task row is how a list ends up with "Work", "work" and
 * "wrok". Making one is Settings → Labels, linked at the bottom.
 */
export function TaskLabelsMenu({
  taskId,
  collection,
}: {
  readonly taskId: string;
  readonly collection: TaskCollection;
}) {
  const { commands } = useWorkspace();
  const snapshot = useTaskCollection(collection);
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  const labels = snapshot.labels;
  const carried = task?.labelIds ?? [];
  const full = carried.length >= LABEL_MAX_PER_TASK;

  /*
   * Nothing is offered until the tree this task lives in has loaded. A toggle sends the whole set, so
   * acting on a set that is only empty because the list has not arrived would take every label off the
   * task — on a phone, where opening a task replaces the list, that is the ordinary case.
   */
  if (!task) {
    return (
      <DropdownMenuGroup>
        <DropdownMenuLabel>Labels</DropdownMenuLabel>
        <p className="sym-menu-note">Loading…</p>
      </DropdownMenuGroup>
    );
  }

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Labels</DropdownMenuLabel>
      {labels.length === 0 ? (
        <p className="sym-menu-note">No labels yet.</p>
      ) : (
        labels.map((label) => {
          const checked = carried.includes(label.id);
          return (
            <DropdownMenuCheckboxItem
              key={label.id}
              checked={checked}
              // A task at the cap can still have labels taken off, only not added.
              disabled={!checked && full}
              onClick={() => void commands.toggleLabel(taskId, label.id, label.name)}
            >
              <span className="sym-label-chip">
                <span
                  aria-hidden="true"
                  className="sym-label-dot"
                  style={{ background: labelColorVariable(label.colour) }}
                />
                {label.name}
              </span>
              {checked ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : null}
            </DropdownMenuCheckboxItem>
          );
        })
      )}
      {full ? (
        <p className="sym-menu-note">{`A task can carry ${LABEL_MAX_PER_TASK} labels.`}</p>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem render={<Link href="/settings/labels" />}>
        <span>Manage labels…</span>
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

/**
 * The label filter above a list: one toggle per label the account has, with how many active tasks
 * carry it.
 *
 * Adding a second label narrows rather than widens, which is what clicking two things in a row looks
 * like it should do. The bar is absent when the account has no labels, so a list nobody has labelled
 * looks exactly as it did before labels existed.
 */
export function LabelFilterBar({ collection }: { readonly collection: TaskCollection }) {
  const { ui } = useWorkspace();
  const { labels } = useTaskCollection(collection);
  const active = useWorkspaceUi((state) => state.labelFilter[collection]);
  if (labels.length === 0) return null;

  return (
    <fieldset className="sym-label-filter">
      <legend className="sr-only">Filter by label</legend>
      {labels.map((label) => {
        const on = active.includes(label.id);
        return (
          <button
            key={label.id}
            type="button"
            className="sym-label-filter-chip"
            aria-pressed={on}
            data-on={on || undefined}
            onClick={() => ui.toggleLabelFilter(collection, label.id)}
          >
            <span
              aria-hidden="true"
              className="sym-label-dot"
              style={{ background: labelColorVariable(label.colour) }}
            />
            {label.name}
            <span className="sym-label-count">{label.taskCount}</span>
          </button>
        );
      })}
      {active.length > 0 ? (
        <button
          type="button"
          className="sym-label-filter-clear"
          onClick={() => ui.clearLabelFilter(collection)}
        >
          <X size={12} strokeWidth={2.2} aria-hidden="true" />
          Clear
        </button>
      ) : null}
    </fieldset>
  );
}

/** The icon the task menu's Labels entry carries, so the entry reads at a glance. */
export function LabelsMenuIcon() {
  return <Tag size={13} strokeWidth={2} aria-hidden="true" />;
}
