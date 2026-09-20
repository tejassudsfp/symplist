"use client";

import type { MeResponse } from "@symplist/contracts";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RESTRICTED_ACCOUNT_PATH } from "../navigation.ts";
import { useSessionControls } from "../session.tsx";
import { useSignOutState } from "./session-states.tsx";

/**
 * The reduced profile menu for screens outside the app (profile_menu.md): identity, the permitted
 * account actions and Sign out. It never exposes protected navigation, because the account cannot
 * open the app from here.
 */
export function IdentityMenu({
  me,
  showAccountLink = true,
}: {
  me: MeResponse;
  showAccountLink?: boolean;
}) {
  const controls = useSessionControls();
  const signOutState = useSignOutState();
  const signingOut = signOutState.kind === "signing_out";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="sym-chrome-button max-w-[240px]"
        aria-label={`Account menu, ${me.user.email}`}
      >
        <span className="truncate">{me.user.displayName ?? me.user.email}</span>
        <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[248px] p-1.5" aria-label="Account">
        <div className="sym-menu-identity">
          {me.user.displayName ? (
            <div className="truncate font-medium">{me.user.displayName}</div>
          ) : null}
          <div className="truncate text-[12.5px] text-sym-muted">{me.user.email}</div>
        </div>
        {showAccountLink ? (
          <DropdownMenuLinkItem render={<Link href={RESTRICTED_ACCOUNT_PATH} />}>
            Account
          </DropdownMenuLinkItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onClick={() => {
            void controls.signOut();
          }}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
