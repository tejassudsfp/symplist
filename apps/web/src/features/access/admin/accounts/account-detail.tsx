"use client";

import { formatInviteHint } from "@symplist/contracts";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { IdempotencyKeys } from "@/lib/api";
import { type AdminAccountAction, useAccessApi } from "../../api.ts";
import { problemOf } from "../../errors.ts";
import { formatDate, formatDateTime } from "../../ui/format.ts";
import { Notice } from "../../ui/notice.tsx";
import {
  accountState,
  accountStateLabels,
  eventSentence,
  grantSourceLabels,
  onboardingLabels,
  restrictionReasonLabels,
} from "../labels.ts";
import { ReasonField, reasonMaxLength } from "../reason-field.tsx";
import { AdminFailed, AdminHeader, AdminLoading, Cell, DataTable, HeadCell, Row } from "../ui.tsx";
import { useResource } from "../use-resource.ts";

interface ActionCopy {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly success: string;
}

const actionCopy: Record<AdminAccountAction, ActionCopy> = {
  unlock: {
    title: "Unlock this account",
    description:
      "The account gets beta access through an administrator grant, recorded with your reason. No invite code is created or sent, and an unverified email stays unverified.",
    confirmLabel: "Unlock account",
    success: "Account unlocked.",
  },
  relock: {
    title: "Relock this account",
    description:
      "New work is refused at once: sessions to the app are closed, running work is stopped where that is possible, and connected-service grants, share links and API keys are revoked. Actions already completed outside Symplist can't be undone. The invite seat is not refunded.",
    confirmLabel: "Relock access",
    success: "Access relocked.",
  },
  "restore-eligibility": {
    title: "Restore eligibility",
    description:
      "The account returns to locked and may redeem a new invite code. It does not get access back by itself, and the old code's seat stays used.",
    confirmLabel: "Restore eligibility",
    success: "The account can redeem a new code.",
  },
  "restore-access": {
    title: "Restore access",
    description:
      "The account is admitted again through a new administrator grant. Approvals, share links, API keys and reminders cancelled by the relock stay cancelled.",
    confirmLabel: "Restore access",
    success: "Access restored.",
  },
};

function actionFailureMessage(error: unknown): { message: string; reload: boolean } {
  const problem = problemOf(error);
  if (problem.kind !== "api") {
    return {
      message:
        problem.kind === "network"
          ? "Symplist couldn't be reached, so nothing changed. Try again."
          : "Something went wrong on our side, so nothing changed. Try again.",
      reload: false,
    };
  }
  switch (problem.code) {
    case "admin.state_changed":
      return {
        message: "This account changed since you opened it. Reload it and decide again.",
        reload: true,
      };
    case "admin.action_unavailable":
      return {
        message: "That action doesn't apply to this account's current state.",
        reload: true,
      };
    case "not_found":
      return { message: "This account no longer exists.", reload: false };
    default:
      return { message: "That change couldn't be applied. Reload the account.", reload: true };
  }
}

/**
 * One account (admin_accounts.md): identity, how it was admitted, and the four access actions, each
 * with a required reason and the access generation the administrator saw, so a concurrent change is
 * refused instead of overwritten. There are no role controls here (§5.7).
 */
export function AccountDetail({ userId }: { userId: string }) {
  const api = useAccessApi();
  const load = useCallback(
    (signal: AbortSignal) => api.accountDetail(userId, signal),
    [api, userId],
  );
  const detail = useResource(`account:${userId}`, load);
  const [action, setAction] = useState<AdminAccountAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; reload: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keys = useMemo(() => new IdempotencyKeys(), []);

  if (detail.status === "loading") return <AdminLoading label="Loading the account" />;
  if (detail.status === "failed" && detail.problem) {
    const missing = detail.problem.kind === "api" && detail.problem.code === "not_found";
    return missing ? (
      <div className="flex flex-col gap-3">
        <AdminHeader title="Account not found" description="It may have been deleted." />
        <Link className="text-sym-link underline-offset-2 hover:underline" href="/admin/accounts">
          Back to accounts
        </Link>
      </div>
    ) : (
      <AdminFailed
        title="Couldn't load this account"
        problem={detail.problem}
        onRetry={() => detail.reload()}
      />
    );
  }
  const data = detail.data;
  if (!data) return null;

  const { account, grants, redemptions, events } = data;
  const state = accountState(account);
  const available: readonly AdminAccountAction[] =
    state === "deleting" || account.suspendedAt !== null
      ? []
      : state === "unlocked"
        ? ["relock"]
        : account.betaState === "relocked"
          ? ["restore-eligibility", "restore-access"]
          : ["unlock"];

  const run = async () => {
    if (!action) return;
    const text = reason.trim();
    if (text.length === 0 || text.length > reasonMaxLength) {
      setFailure({ message: "Write a reason for the activity log.", reload: false });
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const updated = await api.accountAction(
        account.id,
        action,
        { reason: text, expectedGeneration: account.accessGeneration },
        keys.acquire(`${action}:${account.id}:${account.accessGeneration}`),
      );
      detail.set({ ...data, account: updated });
      setNotice(actionCopy[action].success);
      setAction(null);
      setReason("");
      // The grants, redemptions and events change with the action.
      detail.reload();
    } catch (error) {
      setFailure(actionFailureMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <AdminHeader
        title={account.displayName ?? account.email}
        description={
          <>
            {account.email} · {accountStateLabels[state]}
            {account.role === "admin" ? " · Administrator" : ""}
          </>
        }
        actions={
          <Link className={buttonVariants({ size: "lg" })} href="/admin/accounts">
            Back to accounts
          </Link>
        }
      />

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {/* While the action dialog is open the failure belongs to it, so it is never shown twice. */}
      {failure && action === null ? (
        <Notice
          tone="error"
          actions={
            failure.reload ? (
              <Button size="sm" onClick={() => detail.reload()}>
                Reload account
              </Button>
            ) : null
          }
        >
          {failure.message}
        </Notice>
      ) : null}
      {state === "pending" ? (
        <Notice tone="info" live="none">
          This registration was never verified. Unlocking grants beta access but never verifies the
          email — the person still signs in with a code sent to it.
        </Notice>
      ) : null}
      {account.suspendedAt !== null ? (
        <Notice tone="warning" live="none">
          This account is suspended. Suspension is an operator action outside beta administration.
        </Notice>
      ) : null}
      {state === "deleting" ? (
        <Notice tone="warning" live="none">
          This account is being deleted. Its data is already unreadable and no access action
          applies.
        </Notice>
      ) : null}

      <dl className="m-0 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Email verified</dt>
          <dd className="m-0 text-[14px]">
            {account.emailVerifiedAt === null
              ? "Not verified"
              : formatDateTime(account.emailVerifiedAt)}
          </dd>
        </div>
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Registered</dt>
          <dd className="m-0 text-[14px]">{formatDateTime(account.createdAt)}</dd>
        </div>
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Onboarding</dt>
          <dd className="m-0 text-[14px]">{onboardingLabels[account.onboardingStep]}</dd>
        </div>
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Admitted by</dt>
          <dd className="m-0 text-[14px]">
            {account.grantSource ? grantSourceLabels[account.grantSource] : "Not admitted"}
          </dd>
        </div>
      </dl>

      {available.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {available.map((candidate) => (
            <Button
              key={candidate}
              size="lg"
              variant={candidate === "relock" ? "danger" : "primary"}
              onClick={() => {
                setAction(candidate);
                setReason("");
                setFailure(null);
              }}
            >
              {actionCopy[candidate].confirmLabel}
            </Button>
          ))}
        </div>
      ) : null}

      <section aria-labelledby="grants-title" className="flex flex-col gap-3">
        <h2 id="grants-title" className="m-0 font-heading font-semibold text-[15px]">
          Admission history
        </h2>
        {grants.length === 0 ? (
          <p className="m-0 text-[13.5px] text-sym-muted">This account was never admitted.</p>
        ) : (
          <DataTable>
            <caption className="sr-only">Access grants for this account</caption>
            <thead>
              <tr>
                <HeadCell>Source</HeadCell>
                <HeadCell>Granted</HeadCell>
                <HeadCell>Reason</HeadCell>
                <HeadCell>Ended</HeadCell>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <Row key={grant.id}>
                  <Cell label="Source">
                    {grant.inviteId ? (
                      <Link
                        className="text-sym-link underline-offset-2 hover:underline"
                        href={`/admin/invites/${grant.inviteId}`}
                      >
                        {grant.inviteHint
                          ? `Invite ${formatInviteHint(grant.inviteHint)}`
                          : "Invite code"}
                      </Link>
                    ) : (
                      grantSourceLabels[grant.source]
                    )}
                  </Cell>
                  <Cell label="Granted">{formatDateTime(grant.grantedAt)}</Cell>
                  <Cell label="Reason">{grant.reason ?? "—"}</Cell>
                  <Cell label="Ended">
                    {grant.revokedAt === null
                      ? "Current"
                      : `${formatDate(grant.revokedAt)}${
                          grant.revokedReason
                            ? ` · ${restrictionReasonLabels[grant.revokedReason]}`
                            : ""
                        }`}
                  </Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>

      {redemptions.length > 0 ? (
        <section aria-labelledby="redemptions-title" className="flex flex-col gap-3">
          <h2 id="redemptions-title" className="m-0 font-heading font-semibold text-[15px]">
            Codes redeemed
          </h2>
          <DataTable>
            <caption className="sr-only">Invite codes this account redeemed</caption>
            <thead>
              <tr>
                <HeadCell>Code</HeadCell>
                <HeadCell>Seat</HeadCell>
                <HeadCell>Redeemed</HeadCell>
              </tr>
            </thead>
            <tbody>
              {redemptions.map((redemption) => (
                <Row key={redemption.id}>
                  <Cell label="Code">
                    <Link
                      className="text-sym-link underline-offset-2 hover:underline"
                      href={`/admin/invites/${redemption.inviteId}`}
                    >
                      {formatInviteHint(redemption.inviteHint)}
                    </Link>
                  </Cell>
                  <Cell label="Seat">{redemption.seatNo}</Cell>
                  <Cell label="Redeemed">{formatDateTime(redemption.redeemedAt)}</Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </section>
      ) : null}

      <section aria-labelledby="events-title" className="flex flex-col gap-3">
        <h2 id="events-title" className="m-0 font-heading font-semibold text-[15px]">
          Recent activity
        </h2>
        {events.length === 0 ? (
          <p className="m-0 text-[13.5px] text-sym-muted">
            Nothing has happened to this account yet.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {events.map((event) => (
              <li key={event.id} className="text-[13.5px]">
                <span className="text-sym-muted">{formatDateTime(event.createdAt)}</span>{" "}
                {eventSentence(event)}
              </li>
            ))}
          </ul>
        )}
        <div>
          <Link
            className="text-[13px] text-sym-link underline-offset-2 hover:underline"
            href={`/admin/activity?accountId=${account.id}`}
          >
            See every event for this account
          </Link>
        </div>
      </section>

      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        <DialogContent className="max-w-[520px]">
          <DialogTitle>{action ? actionCopy[action].title : ""}</DialogTitle>
          <DialogDescription>{action ? actionCopy[action].description : ""}</DialogDescription>
          <ReasonField value={reason} onChange={setReason} disabled={busy} />
          {failure ? <Notice tone="error">{failure.message}</Notice> : null}
          <DialogActions>
            <Button variant="secondary" size="lg" disabled={busy} onClick={() => setAction(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="lg"
              disabled={busy || reason.trim().length === 0}
              aria-busy={busy || undefined}
              onClick={() => {
                void run();
              }}
            >
              {busy ? <Spinner size={12} /> : null}
              {busy ? "Applying…" : action ? actionCopy[action].confirmLabel : ""}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
