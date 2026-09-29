"use client";

import type { TaskCollection } from "@symplist/contracts";
import { useCallback, useMemo } from "react";
import { type KeyboardPreferences, parseKeyboardPreferences } from "@/actions/bindings";
import { usePlatform } from "@/actions/provider";
import { actionRegistry } from "@/actions/registry-index";
import type { ShellPanelLayout, ShellPanelSeam, ShellSlots } from "@/components/shell/slots";
import { TaskHeader } from "./task-header.tsx";
import { TaskInbox } from "./task-inbox.tsx";
import { usePreferenceGroup, usePreferencesStatus, useWorkspace } from "./workspace-provider.tsx";

/** Panel widths the `panels` preference accepts (decision WS11), so a stored value always saves. */
function clampWidth(value: number | null, min: number, max: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(Math.max(Math.round(value), min), max);
}

export type WorkspaceShellSlots = Pick<
  ShellSlots,
  "inbox" | "taskHeader" | "keyboardPreferences" | "panels"
>;

/**
 * What the workspace feature contributes to the shell (§2.3, decision W11): the task list for each
 * collection, the task page header, the account's keyboard remaps and the persisted desktop panel
 * layout. `FeatureSlots` decides where each one mounts.
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

  /*
   * The stored `panels` group still carries `chatCollapsed` and `chatWidth`, and its schema is a
   * strict object that requires both. There is no chat panel left to report them, so they are
   * vestigial: merged through from whatever the account already has rather than written as fresh
   * defaults, which would rewrite every stored row on the first resize.
   */
  const onLayoutChange = useCallback(
    (layout: ShellPanelLayout) => {
      preferences.update("panels", (current) => ({
        ...current,
        inboxCollapsed: layout.inboxCollapsed,
        inboxWidth: clampWidth(layout.inboxWidth, 200, 640),
      }));
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
      keyboardPreferences,
      panels: panelSeam,
    }),
    [keyboardPreferences, panelSeam],
  );
}
