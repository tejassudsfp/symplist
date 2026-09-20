"use client";

import type { TaskCollection } from "@symplist/contracts";
import { useCallback, useMemo } from "react";
import { type KeyboardPreferences, parseKeyboardPreferences } from "@/actions/bindings";
import { usePlatform } from "@/actions/provider";
import { actionRegistry } from "@/actions/registry-index";
import type { ShellPanelLayout, ShellPanelSeam, ShellSlots } from "@/components/shell/slots";
import { ChatTitle, TaskHeader } from "./task-header.tsx";
import { TaskInbox } from "./task-inbox.tsx";
import { usePreferenceGroup, usePreferencesStatus, useWorkspace } from "./workspace-provider.tsx";

/** Panel widths the `panels` preference accepts (decision WS11), so a stored value always saves. */
function clampWidth(value: number | null, min: number, max: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), min), max);
}

export type WorkspaceShellSlots = Pick<
  ShellSlots,
  "inbox" | "taskHeader" | "chatTitle" | "keyboardPreferences" | "panels"
>;

/**
 * What the workspace feature contributes to the shell (§2.3, decision W11): the task list for each
 * collection, the task page header, the chat's subtitle, the account's keyboard remaps and the
 * persisted desktop panel layout. `FeatureSlots` decides where each one mounts.
 */
export function useWorkspaceSlots(): WorkspaceShellSlots {
  const { preferences } = useWorkspace();
  const platform = usePlatform();
  const status = usePreferencesStatus(preferences);
  const keyboard = usePreferenceGroup(preferences, "keyboard");
  const panels = usePreferenceGroup(preferences, "panels");

  const keyboardPreferences = useMemo<KeyboardPreferences>(
    () => parseKeyboardPreferences(keyboard.data, actionRegistry, platform),
    [keyboard.data, platform],
  );

  const onLayoutChange = useCallback(
    (layout: ShellPanelLayout) => {
      preferences.set("panels", {
        inboxCollapsed: layout.inboxCollapsed,
        chatCollapsed: layout.chatCollapsed,
        inboxWidth: clampWidth(layout.inboxWidth, 200, 640),
        chatWidth: clampWidth(layout.chatWidth, 280, 960),
      });
    },
    [preferences],
  );

  const panelSeam = useMemo<ShellPanelSeam>(
    () => ({
      // Until the account's layout is known the shell keeps the theme's own widths.
      layout: status === "ready" ? panels.data : null,
      onLayoutChange,
    }),
    [status, panels.data, onLayoutChange],
  );

  return useMemo<WorkspaceShellSlots>(
    () => ({
      inbox: (collection) => <TaskInbox collection={collection as TaskCollection} />,
      taskHeader: (taskId) => <TaskHeader taskId={taskId} />,
      chatTitle: (taskId) => <ChatTitle taskId={taskId} />,
      keyboardPreferences,
      panels: panelSeam,
    }),
    [keyboardPreferences, panelSeam],
  );
}
