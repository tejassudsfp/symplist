"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { AccessSummary } from "../account/access-summary.tsx";
import { DeleteAccount } from "../account/delete-account.tsx";
import { destinationPath, navigateAcrossGroups } from "../navigation.ts";
import { useSessionControls } from "../session.tsx";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";

/**
 * Account management for an account that cannot open the app (settings_account.md, restricted
 * variant): identity, sign-out and deletion only, with no links into the protected app and no
 * connector or vault controls. Admitted accounts use Settings → Account instead.
 */
export function RestrictedAccountManagement() {
  const controls = useSessionControls();
  const router = useRouter();
  const me = controls.me;

  if (!me) {
    return (
      <EntryFrame>
        <p role="status" className="text-[13.5px] text-sym-muted">
          Opening your account…
        </p>
      </EntryFrame>
    );
  }

  const back = destinationPath(me);
  const backLabel =
    me.destination === "paused"
      ? "Back to access"
      : me.destination === "beta_gate"
        ? "Back to the invite screen"
        : "Back to Symplist";

  return (
    <EntryFrame>
      <div className="flex flex-col gap-2">
        <ScreenHeading>Your account</ScreenHeading>
        <Lede>
          Everything you can do with this account while it can't open the app: check your identity,
          sign out, or delete the account.
        </Lede>
      </div>
      <AccessSummary me={me} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="lg"
          onClick={() => navigateAcrossGroups(router, back, { replace: true })}
        >
          {backLabel}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          onClick={() => {
            void controls.signOut();
          }}
        >
          Sign out
        </Button>
      </div>
      <DeleteAccount me={me} />
    </EntryFrame>
  );
}
