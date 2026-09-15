"use client";

import { UserRound } from "lucide-react";
import Link from "next/link";
import { useOptionalActions } from "@/actions/provider";
import { SIGN_OUT_ACTION_ID } from "@/actions/shell-actions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronIcon, LockIcon } from "./collection-icons.tsx";
import { initialsFor, useShellSlots } from "./slots.tsx";

interface MenuLink {
  readonly label: string;
  readonly href: string;
  readonly actionId?: string;
}

/** Profile menu destinations (profile_menu.md, overall.md). */
const menuLinks: readonly MenuLink[] = [
  { label: "Settings", href: "/settings/account", actionId: "shell.go_settings" },
  { label: "Connections", href: "/settings/connections" },
  { label: "Calendar", href: "/calendar" },
  { label: "Archive", href: "/archive", actionId: "shell.go_archive" },
  { label: "Keyboard shortcuts", href: "/settings/shortcuts" },
  { label: "About", href: "/settings/about" },
];

function ProfileMenu() {
  const { identity } = useShellSlots();
  const actions = useOptionalActions();
  const signOut = actions?.actions.find((action) => action.id === SIGN_OUT_ACTION_ID);
  const label = identity ? `Account menu, ${identity.displayName}` : "Account menu";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="sym-chrome-button sym-profile-button" aria-label={label}>
        <span className="sym-avatar">
          {identity ? initialsFor(identity) : <UserRound size={14} strokeWidth={2} />}
        </span>
        <span className="sym-profile-name">
          {identity ? identity.displayName.split(/\s+/)[0] : "Account"}
        </span>
        <ChevronIcon direction="down" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[252px] p-1.5" aria-label="Account">
        {identity ? (
          <div className="sym-menu-identity">
            <div className="truncate font-medium">{identity.displayName}</div>
            <div className="truncate text-[12.5px] text-sym-muted">{identity.email}</div>
          </div>
        ) : null}
        {menuLinks.map((item) => {
          const shortcut = item.actionId ? actions?.bindingLabel(item.actionId) : null;
          return (
            <DropdownMenuLinkItem key={item.href} render={<Link href={item.href} />}>
              <span>{item.label}</span>
              {shortcut ? (
                <DropdownMenuShortcut spoken={shortcut.spoken}>
                  {shortcut.display}
                </DropdownMenuShortcut>
              ) : null}
            </DropdownMenuLinkItem>
          );
        })}
        {identity?.isAdmin ? (
          <DropdownMenuLinkItem render={<Link href="/admin/invites" />}>
            Beta administration
          </DropdownMenuLinkItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!signOut}
          onClick={() => {
            void actions?.invoke(SIGN_OUT_ACTION_ID, "menu");
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The restrained top bar (overall.md): profile control at top left with Vault beside it, then slots
 * for the running indicator and the notification control. The Vault link is a full document
 * navigation into its excluded route group and never names items (§15, profile_menu.md).
 */
export function TopBar() {
  const { runningIndicator, notificationControl } = useShellSlots();
  return (
    <header className="sym-topbar">
      <ProfileMenu />
      <a className="sym-chrome-button" href="/vault">
        <LockIcon />
        <span>Vault</span>
      </a>
      <div className="sym-topbar-spacer" />
      <div className="sym-topbar-slot" data-slot="running-indicator">
        {runningIndicator}
      </div>
      <div className="sym-topbar-slot" data-slot="notification-control">
        {notificationControl}
      </div>
    </header>
  );
}
