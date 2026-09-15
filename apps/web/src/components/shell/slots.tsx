"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { CollectionId } from "./routes.ts";

/** The signed-in person shown in the profile control, supplied by the access feature. */
export interface ShellIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly isAdmin: boolean;
}

/**
 * Content features plug into the shell frame. Every slot is optional; the shell renders empty-state
 * placeholders until a feature supplies data.
 */
export interface ShellSlots {
  readonly identity?: ShellIdentity | null;
  /** Top bar, right side: the notification control (scheduling feature). */
  readonly notificationControl?: ReactNode;
  /** Top bar: "Simon is working on …" while a run is active elsewhere (Simon feature). */
  readonly runningIndicator?: ReactNode;
  /** Task list content for a collection (workspace feature). */
  readonly inbox?: (collection: CollectionId) => ReactNode;
  /** Task page header controls: title, completion, view switch, menu (documents and workspace). */
  readonly taskHeader?: (taskId: string) => ReactNode;
  /** Task chat content and composer (Simon feature). */
  readonly chat?: (taskId: string) => ReactNode;
  /** Chat header subtitle, normally the task title. */
  readonly chatTitle?: (taskId: string) => ReactNode;
  /**
   * A short status for the collapsed chat's corner control, such as "Approval waiting" or "Simon is
   * working" (Simon feature). It shows as a dot on the control and is part of its accessible name.
   */
  readonly chatStatus?: (taskId: string) => string | null;
  /** Bottom-right floating quick chat, shown only when no task is selected (decision D1). */
  readonly quickChat?: ReactNode;
}

const ShellSlotsContext = createContext<ShellSlots>({});

export function ShellSlotsProvider({
  value,
  children,
}: {
  value: ShellSlots;
  children: ReactNode;
}) {
  return <ShellSlotsContext.Provider value={value}>{children}</ShellSlotsContext.Provider>;
}

export function useShellSlots(): ShellSlots {
  return useContext(ShellSlotsContext);
}

/** Two-letter initials for the avatar, falling back to the email's first letter. */
export function initialsFor(identity: ShellIdentity): string {
  const words = identity.displayName.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2
      ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? identity.email.slice(0, 1));
  return letters.toUpperCase();
}
