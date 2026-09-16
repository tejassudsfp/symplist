"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RESTRICTED_ACCOUNT_PATH } from "../navigation.ts";
import { takeInterruption, useSessionControls } from "../session.tsx";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";
import { Notice } from "../ui/notice.tsx";
import { IdentityMenu } from "./identity-menu.tsx";
import { useDestinationGuard } from "./use-destination-guard.ts";

/**
 * Paused access (access_revoked.md): an account whose beta grant was withdrawn or that is suspended.
 * It differs from a new locked account — there is no code field, because another invite must not
 * bypass an administrator's decision (note 04). Reaching it from an open task also explains what
 * happened to work in progress, without promising anything was saved or undone.
 */
export function AccessPaused() {
  const controls = useSessionControls();
  const { me, allowed } = useDestinationGuard(["paused"]);
  const [interrupted, setInterrupted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState<"network" | "unexpected" | null>(null);
  const [unchanged, setUnchanged] = useState(false);

  useEffect(() => {
    if (takeInterruption()) setInterrupted(true);
  }, []);

  if (!me || !allowed) {
    return (
      <EntryFrame>
        <p role="status" className="text-[13.5px] text-sym-muted">
          Opening your account…
        </p>
      </EntryFrame>
    );
  }

  const suspended = me.access.suspendedAt !== null;

  const checkAccess = async () => {
    if (checking) return;
    setChecking(true);
    setFailed(null);
    setUnchanged(false);
    const snapshot = await controls.refresh();
    setChecking(false);
    if (snapshot.loadError) {
      setFailed(snapshot.loadError);
      return;
    }
    if (snapshot.me?.destination === "paused") setUnchanged(true);
  };

  return (
    <EntryFrame headerEnd={<IdentityMenu me={me} />}>
      <div className="flex flex-col gap-2">
        <ScreenHeading focusOnMount={interrupted}>Access is currently paused</ScreenHeading>
        <Lede>
          {suspended
            ? "This account is suspended, so the app isn't available right now."
            : "An administrator paused this account's beta access, so the app isn't available right now."}{" "}
          Access can only be restored by the people who run this Symplist deployment.
        </Lede>
      </div>
      {interrupted ? (
        <Notice tone="warning" title="Your session was interrupted">
          Work in progress was stopped where that was possible. Anything already sent to another
          service can't be taken back, and changes that weren't saved may not have been kept.
        </Notice>
      ) : null}
      {failed ? (
        <Notice tone="error" title="We couldn't check your access">
          {failed === "network"
            ? "Symplist couldn't be reached. Check your connection and try again."
            : "Something went wrong on our side. Try again in a moment."}
        </Notice>
      ) : null}
      {unchanged ? (
        <Notice tone="info">Access is still paused. Nothing has changed yet.</Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="lg"
          disabled={checking}
          aria-busy={checking || undefined}
          onClick={() => {
            void checkAccess();
          }}
        >
          {checking ? <Spinner size={12} /> : null}
          {checking ? "Checking…" : "Check access"}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => {
            void controls.signOut();
          }}
        >
          Sign out
        </Button>
      </div>
      <div className="flex flex-col gap-2 border-sym-line border-t pt-4 text-[13px] text-sym-muted">
        <p className="m-0">Signed in as {me.user.email}.</p>
        <p className="m-0 [text-wrap:pretty]">
          An invite code can't reopen a paused account. You can still{" "}
          <Link
            className="text-sym-link underline-offset-2 hover:underline"
            href={RESTRICTED_ACCOUNT_PATH}
          >
            manage or delete your account
          </Link>
          .
        </p>
      </div>
    </EntryFrame>
  );
}
