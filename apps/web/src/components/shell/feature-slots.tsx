"use client";

import { type ReactNode, useMemo } from "react";
import { useSession } from "@/features/access/session";
import { ConsentBanner } from "@/features/analytics/consent-banner";
import { DocumentPane } from "@/features/documents/document-pane";
import { NotificationControl } from "@/features/scheduling/notification-control";
import { CommandPalette } from "@/features/search/command-palette";
import { ChatPane } from "@/features/simon/chat-pane";
import { QuickChatLauncher } from "@/features/simon/quick-chat";
import { VaultStatus } from "@/features/vault/vault-status";
import { type ShellIdentity, type ShellSlots, ShellSlotsProvider } from "./slots.tsx";

/**
 * Plugs each feature's seam component into the shell slots (§2.3, decision W9). Features replace
 * their component's implementation in place; this file only decides where each one mounts. The page
 * and chat panes are keyed by task, so switching tasks never carries one task's state into another.
 */
export function FeatureSlots({ children }: { children: ReactNode }) {
  const { status, user } = useSession();
  const identity = useMemo<ShellIdentity | null>(
    () =>
      status === "signed_in" && user
        ? { displayName: user.displayName, email: user.email, isAdmin: user.role === "admin" }
        : null,
    [status, user],
  );
  const slots = useMemo<ShellSlots>(
    () => ({
      identity,
      vaultStatus: <VaultStatus />,
      notificationControl: <NotificationControl />,
      page: (taskId) => <DocumentPane key={taskId} taskId={taskId} />,
      chat: (taskId) => <ChatPane key={taskId} taskId={taskId} />,
      quickChat: <QuickChatLauncher />,
      commandPalette: <CommandPalette />,
      consentBanner: <ConsentBanner />,
    }),
    [identity],
  );
  return <ShellSlotsProvider value={slots}>{children}</ShellSlotsProvider>;
}
