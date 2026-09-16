"use client";

import type { TaskCollection } from "@symplist/contracts";
import { taskCollections } from "@symplist/contracts";
import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useOptionalActions } from "@/actions/provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { collectionLabels } from "./commands.ts";
import { taskMenuExtensions } from "./task-menu-extensions.ts";
import type { TaskSurface } from "./ui-store.ts";
import { useWorkspace, useWorkspaceUi } from "./workspace-provider.tsx";

function Shortcut({ actionId }: { readonly actionId: string }) {
  const actions = useOptionalActions();
  const label = actions?.bindingLabel(actionId);
  if (!label) return null;
  return <DropdownMenuShortcut spoken={label.spoken}>{label.display}</DropdownMenuShortcut>;
}

export interface TaskMenuTask {
  readonly id: string;
  readonly title: string;
  readonly collection: TaskCollection;
}

export interface TaskMenuProps {
  readonly task: TaskMenuTask;
  readonly surface: TaskSurface;
  /** The trigger's classes, so the row and the page header can style their own control. */
  readonly className?: string;
  /** Extra entries only this surface offers, such as the task page's History link. */
  readonly extra?: ReactNode;
  readonly tabIndex?: number;
}

/**
 * The task menu (task_actions.md): Rename, Add subtask, Move to…, anything other features contribute,
 * and Complete. Every entry runs the same command as the keyboard and shows its current shortcut, and
 * "Move to…" opens the destination list that is the keyboard and touch alternative to dragging.
 */
export function TaskMenu({ task, surface, className, extra, tabIndex }: TaskMenuProps) {
  const { ui, commands } = useWorkspace();
  const menu = useWorkspaceUi((state) => state.menu);
  const open = menu?.taskId === task.id && menu.surface === surface;
  const kind = open ? menu.kind : "task";

  const close = () => ui.closeMenu();

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) ui.openMenu(task.id, "task", surface);
        else close();
      }}
    >
      <DropdownMenuTrigger
        className={className ?? "sym-task-tool"}
        aria-label={`Task menu for ${task.title}`}
        {...(tabIndex === undefined ? {} : { tabIndex })}
      >
        <MoreHorizontal size={15} strokeWidth={2.2} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[212px]"
        aria-label={kind === "move" ? "Move to" : "Task actions"}
      >
        {kind === "move" ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {taskCollections
              .filter((destination) => destination !== task.collection)
              .map((destination) => (
                <DropdownMenuItem
                  key={destination}
                  onClick={() => {
                    close();
                    void commands.moveToCollection(task.id, destination);
                  }}
                >
                  {collectionLabels[destination]}
                </DropdownMenuItem>
              ))}
          </DropdownMenuGroup>
        ) : (
          <>
            <DropdownMenuItem
              onClick={() => {
                ui.startRename(task.id, task.title, surface);
              }}
            >
              <span>Rename</span>
              <Shortcut actionId="workspace.rename_task" />
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                close();
                ui.setExpanded(task.id, true);
                ui.setSubDraft(task.id, "");
              }}
            >
              <span>Add subtask</span>
              <Shortcut actionId="workspace.new_subtask" />
            </DropdownMenuItem>
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => ui.openMenu(task.id, "move", surface)}
            >
              <span>Move to…</span>
              <Shortcut actionId="workspace.move_task" />
            </DropdownMenuItem>
            {taskMenuExtensions
              .filter((entry) => entry.available?.(task.id) ?? true)
              .map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  onClick={() => {
                    close();
                    entry.onSelect(task.id);
                  }}
                >
                  <span>{entry.label}</span>
                  {entry.actionId ? <Shortcut actionId={entry.actionId} /> : null}
                </DropdownMenuItem>
              ))}
            {extra}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                close();
                void commands.complete(task.id);
              }}
            >
              <span>Complete</span>
              <Shortcut actionId="workspace.complete_task" />
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The task page header's extra entry: the document's history (note 11, `g h`). */
export function TaskHistoryMenuItem({ taskId }: { readonly taskId: string }) {
  return (
    <DropdownMenuLinkItem render={<Link href={`/tasks/${taskId}/history`} />}>
      <span>History</span>
      <Shortcut actionId="documents.open_history" />
    </DropdownMenuLinkItem>
  );
}
