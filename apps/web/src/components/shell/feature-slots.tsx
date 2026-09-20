"use client";

import { type ReactNode, useMemo } from "react";
import { useSession } from "@/features/access/session";
import { ConsentBanner } from "@/features/analytics/consent-banner";
import { DocumentPane } from "@/features/documents/document-pane";
import { NotificationControl } from "@/features/scheduling/notification-control";
import { SchedulingProvider } from "@/features/scheduling/provider";
import { CommandPalette } from "@/features/search/command-palette";
import { ChatPane } from "@/features/simon/chat-pane";
import { SimonProvider } from "@/features/simon/provider";
import { QuickChatLauncher } from "@/features/simon/quick-chat";
import { VaultStatus } from "@/features/vault/vault-status";
import { WorkspaceDialogs } from "@/features/workspace/dialogs";
import { useWorkspaceSlots } from "@/features/workspace/shell-slots";
import { WorkspaceProvider } from "@/features/workspace/workspace-provider";
import { type ShellIdentity, type ShellSlots, ShellSlotsProvider } from "./slots.tsx";

/**
 * Plugs each feature's seam component into the shell slots (§2.3, decision W9). Features replace
 * their component's implementation in place; this file only decides where each one mounts. The page
 * and chat panes are keyed by task, so switching tasks never carries one task's state into another.
 *
 * The workspace's provider wraps everything inside the shell, so its task list, the task page header,
 * the chat subtitle, the archive and settings pages and the keyboard actions share one set of stores.
 */
export function FeatureSlots({ children }: { children: ReactNode }) {
  const { status, user } = useSession();
  return (
    <WorkspaceProvider userId={user?.id ?? null}>
      <SchedulingProvider key={user?.id ?? "signed-out"} userId={user?.id ?? null}>
        <SimonProvider key={user?.id ?? "signed-out"} userId={user?.id ?? null}>
          <MountedSlots
            identity={
              status === "signed_in" && user
                ? {
                    displayName: user.displayName,
                    email: user.email,
                    isAdmin: user.role === "admin",
                  }
                : null
            }
          >
            {children}
          </MountedSlots>
        </SimonProvider>
      </SchedulingProvider>
    </WorkspaceProvider>
  );
}

function MountedSlots({
  identity,
  children,
}: {
  readonly identity: ShellIdentity | null;
  readonly children: ReactNode;
}) {
  const workspace = useWorkspaceSlots();
  const slots = useMemo<ShellSlots>(
    () => ({
      identity,
      vaultStatus: <VaultStatus />,
      notificationControl: <NotificationControl />,
      inbox: workspace.inbox,
      taskHeader: workspace.taskHeader,
      chatTitle: workspace.chatTitle,
      keyboardPreferences: workspace.keyboardPreferences,
      panels: workspace.panels,
      page: (taskId) => <DocumentPane key={taskId} taskId={taskId} />,
      chat: (taskId) => <ChatPane key={taskId} taskId={taskId} />,
      quickChat: <QuickChatLauncher />,
      commandPalette: <CommandPalette />,
      consentBanner: <ConsentBanner />,
    }),
    [identity, workspace],
  );
  return (
    <ShellSlotsProvider value={slots}>
      {children}
      <WorkspaceDialogs />
    </ShellSlotsProvider>
  );
}
