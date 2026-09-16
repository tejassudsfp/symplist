import type { ActionAvailability, ActionEnvironment, AppAction } from "@/actions/types";
import {
  expandActiveRow,
  focusQuickAdd,
  moveActiveRow,
  openNeighbourTask,
  surfaceFor,
  targetTaskId,
  visibleTaskRows,
  type WorkspaceCommandBridge,
  workspaceCommands,
} from "./controller.ts";

const enabled: ActionAvailability = { enabled: true };
const noWorkspace: ActionAvailability = {
  enabled: false,
  reason: "Available in the task workspace",
};
const noTask: ActionAvailability = {
  enabled: false,
  reason: "Open a task, or focus one in the task list",
};
const noRow: ActionAvailability = { enabled: false, reason: "Focus a task in the list first" };

function bridgeFor(): WorkspaceCommandBridge | null {
  return workspaceCommands();
}

function withTask(
  environment: ActionEnvironment,
  run: (bridge: WorkspaceCommandBridge, taskId: string) => void,
): void {
  const bridge = bridgeFor();
  if (!bridge) return;
  const taskId = targetTaskId(bridge, environment.pane);
  if (taskId) run(bridge, taskId);
}

function taskAvailability(environment: ActionEnvironment): ActionAvailability {
  const bridge = bridgeFor();
  if (!bridge) return noWorkspace;
  return targetTaskId(bridge, environment.pane) ? enabled : noTask;
}

function rowAvailability(): ActionAvailability {
  const bridge = bridgeFor();
  if (!bridge) return noWorkspace;
  const collection = bridge.collection();
  if (!collection) return noWorkspace;
  return bridge.ui.getState().activeRow[collection] ? enabled : noRow;
}

function listAvailability(): ActionAvailability {
  const bridge = bridgeFor();
  if (!bridge?.collection()) return noWorkspace;
  return enabled;
}

function activeRowOf(bridge: WorkspaceCommandBridge): string | null {
  const collection = bridge.collection();
  return collection ? bridge.ui.getState().activeRow[collection] : null;
}

/**
 * The workspace's actions with the note 13 bindings. Every one of them is the same action the rows,
 * menus and buttons invoke (§10.2), so a remap changes every label and a disabled action explains
 * itself instead of doing nothing.
 */
export const workspaceActions: readonly AppAction[] = [
  {
    id: "workspace.next_task",
    label: "Next task",
    context: "pane",
    pane: "inbox",
    group: "navigation",
    keywords: ["down", "move"],
    defaultBinding: "j",
    allowRepeat: true,
    availability: listAvailability,
    run: () => {
      const bridge = bridgeFor();
      if (bridge) moveActiveRow(bridge, 1);
    },
  },
  {
    id: "workspace.previous_task",
    label: "Previous task",
    context: "pane",
    pane: "inbox",
    group: "navigation",
    keywords: ["up", "move"],
    defaultBinding: "k",
    allowRepeat: true,
    availability: listAvailability,
    run: () => {
      const bridge = bridgeFor();
      if (bridge) moveActiveRow(bridge, -1);
    },
  },
  {
    id: "workspace.next_task_arrow",
    label: "Next task (arrow key)",
    context: "pane",
    pane: "inbox",
    group: "navigation",
    defaultBinding: "arrowdown",
    allowRepeat: true,
    availability: listAvailability,
    run: () => {
      const bridge = bridgeFor();
      if (bridge) moveActiveRow(bridge, 1);
    },
  },
  {
    id: "workspace.previous_task_arrow",
    label: "Previous task (arrow key)",
    context: "pane",
    pane: "inbox",
    group: "navigation",
    defaultBinding: "arrowup",
    allowRepeat: true,
    availability: listAvailability,
    run: () => {
      const bridge = bridgeFor();
      if (bridge) moveActiveRow(bridge, -1);
    },
  },
  {
    id: "workspace.expand_task",
    label: "Expand subtasks",
    context: "pane",
    pane: "inbox",
    group: "tasks",
    keywords: ["sublist", "open"],
    defaultBinding: "arrowright",
    availability: rowAvailability,
    run: () => {
      const bridge = bridgeFor();
      if (bridge) expandActiveRow(bridge, true);
    },
  },
  {
    id: "workspace.collapse_task",
    label: "Collapse subtasks",
    context: "pane",
    pane: "inbox",
    group: "tasks",
    keywords: ["sublist", "close"],
    defaultBinding: "arrowleft",
    availability: rowAvailability,
    run: () => {
      const bridge = bridgeFor();
      if (bridge) expandActiveRow(bridge, false);
    },
  },
  {
    id: "workspace.open_task",
    label: "Open task",
    context: "pane",
    pane: "inbox",
    group: "navigation",
    keywords: ["select", "page", "chat"],
    defaultBinding: "enter",
    availability: rowAvailability,
    run: () => {
      const bridge = bridgeFor();
      if (!bridge) return;
      const taskId = activeRowOf(bridge);
      const task = taskId ? bridge.tasks.findLoaded(taskId) : undefined;
      if (task) bridge.openTask(task.collection, task.id);
    },
  },
  {
    id: "workspace.task_menu",
    label: "Open task menu",
    context: "app",
    group: "tasks",
    keywords: ["actions", "more"],
    defaultBinding: "shift+f10",
    availability: taskAvailability,
    run: (environment) => {
      withTask(environment, (bridge, taskId) => {
        bridge.ui.openMenu(taskId, "task", surfaceFor(environment.pane));
      });
    },
  },
  {
    id: "workspace.new_task",
    label: "New task",
    context: "app",
    group: "tasks",
    keywords: ["add", "create", "capture"],
    defaultBinding: "n",
    availability: listAvailability,
    run: ({ services }) => {
      const bridge = bridgeFor();
      if (!bridge) return;
      // The list may be hidden (a collapsed panel, the laptop drawer, a phone's page view).
      services.shell?.revealInbox();
      requestAnimationFrame(() => focusQuickAdd());
    },
  },
  {
    id: "workspace.new_subtask",
    label: "New subtask",
    context: "app",
    group: "tasks",
    keywords: ["add", "child", "nested"],
    defaultBinding: "shift+n",
    availability: taskAvailability,
    run: (environment) => {
      withTask(environment, (bridge, taskId) => {
        bridge.ui.setExpanded(taskId, true);
        bridge.ui.setSubDraft(taskId, "");
      });
    },
  },
  {
    id: "workspace.rename_task",
    label: "Rename task",
    context: "app",
    group: "tasks",
    keywords: ["title", "edit"],
    defaultBinding: "r",
    availability: taskAvailability,
    run: (environment) => {
      withTask(environment, (bridge, taskId) => {
        const title =
          bridge.tasks.findLoaded(taskId)?.title ??
          bridge.tasks.detail(taskId).detail?.task.title ??
          "";
        bridge.ui.startRename(taskId, title, surfaceFor(environment.pane));
      });
    },
  },
  {
    id: "workspace.move_task",
    label: "Move task to…",
    context: "app",
    group: "tasks",
    keywords: ["now", "later", "unclassified", "collection"],
    defaultBinding: "m",
    availability: taskAvailability,
    run: (environment) => {
      withTask(environment, (bridge, taskId) => {
        bridge.ui.openMenu(taskId, "move", surfaceFor(environment.pane));
      });
    },
  },
  {
    id: "workspace.complete_task",
    label: "Complete task",
    context: "app",
    group: "tasks",
    keywords: ["done", "archive", "finish"],
    defaultBinding: "x",
    availability: taskAvailability,
    run: (environment) => {
      withTask(environment, (bridge, taskId) => {
        void bridge.commands.complete(taskId);
      });
    },
  },
  {
    id: "workspace.next_open_task",
    label: "Open next task",
    context: "app",
    group: "navigation",
    keywords: ["following", "neighbour"],
    defaultBinding: "]",
    availability: () => {
      const bridge = bridgeFor();
      const collection = bridge?.collection();
      if (!bridge || !collection) return noWorkspace;
      return visibleTaskRows(bridge, collection).length > 0
        ? enabled
        : { enabled: false, reason: "This list has no tasks yet" };
    },
    run: () => {
      const bridge = bridgeFor();
      if (bridge) openNeighbourTask(bridge, 1);
    },
  },
  {
    id: "workspace.previous_open_task",
    label: "Open previous task",
    context: "app",
    group: "navigation",
    keywords: ["preceding", "neighbour"],
    defaultBinding: "[",
    availability: () => {
      const bridge = bridgeFor();
      const collection = bridge?.collection();
      if (!bridge || !collection) return noWorkspace;
      return visibleTaskRows(bridge, collection).length > 0
        ? enabled
        : { enabled: false, reason: "This list has no tasks yet" };
    },
    run: () => {
      const bridge = bridgeFor();
      if (bridge) openNeighbourTask(bridge, -1);
    },
  },
  {
    id: "workspace.search_list",
    label: "Search this list",
    context: "pane",
    pane: "inbox",
    group: "search",
    keywords: ["filter", "find"],
    availability: listAvailability,
    run: () => {
      const bridge = bridgeFor();
      const collection = bridge?.collection();
      if (bridge && collection) bridge.ui.setSearchOpen(collection, true);
    },
  },
];
