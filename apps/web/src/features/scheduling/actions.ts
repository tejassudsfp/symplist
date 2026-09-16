import type { AppAction } from "@/actions/types";
import { targetTaskId, workspaceCommands } from "@/features/workspace/controller";
import { openNotifications, scheduleOverlay } from "./store.ts";

/** Actions contributed by the scheduling feature to the command registry (§10.2). */
export const schedulingActions: readonly AppAction[] = [
  {
    id: "scheduling.calendar",
    label: "Open calendar",
    context: "app",
    group: "navigation",
    availability: () => ({ enabled: true }),
    run: ({ services }) => services.navigate("/calendar"),
  },
  {
    id: "scheduling.notifications",
    label: "Open notifications",
    context: "app",
    group: "navigation",
    availability: () => ({ enabled: true }),
    run: openNotifications,
  },
  {
    id: "scheduling.settings",
    label: "Notification settings",
    context: "app",
    group: "general",
    availability: () => ({ enabled: true }),
    run: ({ services }) => services.navigate("/settings/notifications"),
  },
  ...([false, true] as const).map(
    (reminder): AppAction => ({
      id: reminder ? "scheduling.add_reminder" : "scheduling.set_deadline",
      label: reminder ? "Add reminder" : "Set deadline",
      context: "app",
      group: "tasks",
      availability: ({ pane }) => {
        const bridge = workspaceCommands();
        return bridge && targetTaskId(bridge, pane)
          ? { enabled: true }
          : { enabled: false, reason: "Select a task first" };
      },
      run: ({ pane }) => {
        const bridge = workspaceCommands();
        const task = bridge ? targetTaskId(bridge, pane) : null;
        if (task) scheduleOverlay.open(task, reminder);
      },
    }),
  ),
  {
    id: "scheduling.snooze",
    label: "Snooze notification",
    context: "app",
    group: "tasks",
    availability: () => ({ enabled: true }),
    run: openNotifications,
  },
];
