"use client";

import { createContext, type ReactNode, useContext } from "react";
import type { KeyboardPreferences } from "@/actions/bindings";
import type { CollectionId } from "./routes.ts";

/** The signed-in person shown in the profile control, supplied by the access feature. */
export interface ShellIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly isAdmin: boolean;
}

/** The desktop panel layout the workspace persists per account (§10.3, `panels` group). */
export interface ShellPanelLayout {
  /** Task list width in CSS pixels, or null for the theme's default. */
  readonly inboxWidth: number | null;
  readonly chatWidth: number | null;
  readonly inboxCollapsed: boolean;
  readonly chatCollapsed: boolean;
}

/**
 * Panel persistence seam (workspace feature). The shell owns the panels; the feature owns the stored
 * preference, so it hands the shell the account's layout once it is known and hears about changes.
 */
export interface ShellPanelSeam {
  /** The account's layout, or null while it is still loading (the shell keeps its defaults). */
  readonly layout: ShellPanelLayout | null;
  /** Called when a panel is resized or collapsed, with the layout to store. */
  readonly onLayoutChange: (layout: ShellPanelLayout) => void;
}

/**
 * Content features plug into the shell frame. Every slot is optional: a missing slot leaves its area
 * empty, except the task list, which shows its empty state. In the app, `FeatureSlots`
 * (`feature-slots.tsx`) fills the slots with each feature's seam component.
 */
export interface ShellSlots {
  readonly identity?: ShellIdentity | null;
  /**
   * The account's keyboard remaps and the disable-single-key toggle (§10.2, `keyboard` group),
   * supplied by the workspace feature; the shell hands them to the action registry so every binding,
   * label and menu hint follows the account (note 13).
   */
  readonly keyboardPreferences?: KeyboardPreferences;
  /** Desktop panel widths and collapse, persisted per account by the workspace feature. */
  readonly panels?: ShellPanelSeam;
  /** Top bar, beside the Vault link: the Vault's lock status (vault feature). */
  readonly vaultStatus?: ReactNode;
  /** Top bar, right side: the notification control (scheduling feature). */
  readonly notificationControl?: ReactNode;
  /** Top bar: "Simon is working on …" while a run is active elsewhere (Simon feature). */
  readonly runningIndicator?: ReactNode;
  /** Task list content for a collection (workspace feature). */
  readonly inbox?: (collection: CollectionId) => ReactNode;
  /** Task page header controls: title, completion, view switch, menu (documents and workspace). */
  readonly taskHeader?: (taskId: string) => ReactNode;
  /**
   * The selected task's page in the page frame (documents feature), rendered before the route's own
   * content. Task routes render nothing themselves, so the page keeps its state when the task moves
   * to another collection.
   */
  readonly page?: (taskId: string) => ReactNode;
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
  /**
   * The command palette (search feature), mounted once inside the action registry and kept mounted
   * when the route moves between the workspace and other pages.
   */
  readonly commandPalette?: ReactNode;
  /** The analytics consent banner (analytics feature), mounted once like the palette. */
  readonly consentBanner?: ReactNode;
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
