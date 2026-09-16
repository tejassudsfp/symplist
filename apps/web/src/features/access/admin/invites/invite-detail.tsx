"use client";

import { type AdminInvite, formatInviteHint, inviteMaxExpiryDays } from "@symplist/contracts";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { IdempotencyKeys } from "@/lib/api";
import { useAccessApi } from "../../api.ts";
import { problemOf } from "../../errors.ts";
import { TextField } from "../../ui/field.tsx";
import {
  addDays,
  endOfLocalDay,
  formatDate,
  formatDateTime,
  toDateInputValue,
} from "../../ui/format.ts";
import { Notice } from "../../ui/notice.tsx";
import { inviteStatusLabels } from "../labels.ts";
import { AdminFailed, AdminHeader, AdminLoading, Cell, DataTable, HeadCell, Row } from "../ui.tsx";
import { useResource } from "../use-resource.ts";
import { CampaignRevocation } from "./campaign-revocation.tsx";

type EditKind = "capacity" | "expiry" | null;

interface EditFailure {
  readonly message: string;
  /** The invite on screen is out of date: reloading is the way forward. */
  readonly reload: boolean;
}

function editFailure(error: unknown, used: number): EditFailure {
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
    case "invite.changed":
      return {
        message: "This invite changed since you opened it. Reload it and try again.",
        reload: true,
      };
    case "invite.revoked":
      return { message: "This invite is revoked, so it can't be edited any more.", reload: true };
    case "invite.capacity_below_used":
      return {
        message: `The cap can't go below the ${used} seat${used === 1 ? "" : "s"} already used.`,
        reload: true,
      };
    case "invite.expiry_invalid":
      return {
        message: "Choose a date later than the current expiry and within a year.",
        reload: false,
      };
    case "not_found":
      return { message: "This invite no longer exists.", reload: false };
    default:
      return { message: "That change couldn't be applied. Reload the invite.", reload: true };
  }
}

/**
 * One invite (admin_invites.md): its label, hint, status, seats and the accounts that redeemed it,
 * with the three edits an operator needs. A cap never drops below the seats already used, an expiry
 * only moves later, and revoking stops future redemptions without touching admitted accounts.
 */
export function InviteDetail({ inviteId }: { inviteId: string }) {
  const api = useAccessApi();
  const load = useCallback(
    (signal: AbortSignal) => api.inviteDetail(inviteId, signal),
    [api, inviteId],
  );
  const detail = useResource(`invite:${inviteId}`, load);
  const [edit, setEdit] = useState<EditKind>(null);
  const [capacity, setCapacity] = useState("");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<EditFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const keys = useMemo(() => new IdempotencyKeys(), []);

  if (detail.status === "loading") return <AdminLoading label="Loading the invite" />;
  if (detail.status === "failed" && detail.problem) {
    const missing = detail.problem.kind === "api" && detail.problem.code === "not_found";
    return missing ? (
      <div className="flex flex-col gap-3">
        <AdminHeader title="Invite not found" description="This code may have been removed." />
        <Link className="text-sym-link underline-offset-2 hover:underline" href="/admin/invites">
          Back to invites
        </Link>
      </div>
    ) : (
      <AdminFailed
        title="Couldn't load this invite"
        problem={detail.problem}
        onRetry={() => detail.reload()}
      />
    );
  }
  const data = detail.data;
  if (!data) return null;

  const { invite, redemptions } = data;

  const applyUpdate = (updated: AdminInvite, message: string) => {
    detail.set({ ...data, invite: updated });
    setNotice(message);
    setFailure(null);
    setEdit(null);
  };

  const saveCapacity = async () => {
    const value = Number(capacity);
    if (!Number.isInteger(value) || value < 1) {
      setFailure({ message: "Enter a whole number of seats, at least 1.", reload: false });
      return;
    }
    if (value < invite.used) {
      setFailure({
        message: `The cap can't go below the ${invite.used} seat${invite.used === 1 ? "" : "s"} already used.`,
        reload: false,
      });
      return;
    }
    setBusy(true);
    try {
      const updated = await api.updateInviteCapacity(
        invite.id,
        { maxRedemptions: value, expectedVersion: invite.version },
        keys.acquire(`capacity:${invite.id}:${invite.version}:${value}`),
      );
      applyUpdate(updated, `Capacity is now ${updated.maxRedemptions}.`);
    } catch (error) {
      setFailure(editFailure(error, invite.used));
    } finally {
      setBusy(false);
    }
  };

  const saveExpiry = async () => {
    const value = endOfLocalDay(expiry);
    if (value === null) {
      setFailure({ message: "Choose a date.", reload: false });
      return;
    }
    if (value <= invite.expiresAt) {
      setFailure({ message: "Choose a date later than the current expiry.", reload: false });
      return;
    }
    setBusy(true);
    try {
      const updated = await api.extendInviteExpiry(
        invite.id,
        { expiresAt: value, expectedVersion: invite.version },
        keys.acquire(`expiry:${invite.id}:${invite.version}:${value}`),
      );
      applyUpdate(updated, `This code now expires on ${formatDate(updated.expiresAt)}.`);
    } catch (error) {
      setFailure(editFailure(error, invite.used));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      const updated = await api.revokeInvite(
        invite.id,
        { expectedVersion: invite.version },
        keys.acquire(`revoke:${invite.id}:${invite.version}`),
      );
      applyUpdate(updated, "This code can no longer be redeemed.");
      setConfirmRevoke(false);
    } catch (error) {
      setFailure(editFailure(error, invite.used));
      setConfirmRevoke(false);
    } finally {
      setBusy(false);
    }
  };

  const editable = invite.revokedAt === null;

  return (
    <div className="flex flex-col gap-5">
      <AdminHeader
        title={invite.label ?? "Invite code"}
        description={
          <>
            <span className="font-mono">{formatInviteHint(invite.hint)}</span> ·{" "}
            {inviteStatusLabels[invite.status]} · {invite.used} of {invite.maxRedemptions} seats
            used
          </>
        }
        actions={
          <Link className={buttonVariants({ size: "lg" })} href="/admin/invites">
            Back to invites
          </Link>
        }
      />

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {/* While a dialog is open the failure belongs to it, so it is never shown twice. */}
      {failure && edit === null && !confirmRevoke ? (
        <Notice
          tone="error"
          actions={
            failure.reload ? (
              <Button size="sm" onClick={() => detail.reload()}>
                Reload invite
              </Button>
            ) : null
          }
        >
          {failure.message}
        </Notice>
      ) : null}

      <dl className="m-0 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Mode</dt>
          <dd className="m-0 text-[14px]">
            {invite.mode === "shared" ? "One shared campaign code" : "Independent code"}
          </dd>
        </div>
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Seats left</dt>
          <dd className="m-0 text-[14px]">{invite.remaining}</dd>
        </div>
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Expires</dt>
          <dd className="m-0 text-[14px]">{formatDateTime(invite.expiresAt)}</dd>
        </div>
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Created</dt>
          <dd className="m-0 text-[14px]">{formatDateTime(invite.createdAt)}</dd>
        </div>
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Bound email</dt>
          <dd className="m-0 text-[14px]">{invite.boundEmail ?? "Anyone with the code"}</dd>
        </div>
        <div>
          <dt className="m-0 text-[12.5px] text-sym-muted">Campaign</dt>
          <dd className="m-0 text-[14px]">
            <Link
              className="text-sym-link underline-offset-2 hover:underline"
              href={`/admin/invites?campaignId=${encodeURIComponent(invite.campaignId)}`}
            >
              All codes from this batch
            </Link>
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button
          size="lg"
          disabled={!editable}
          onClick={() => {
            setCapacity(String(invite.maxRedemptions + 1));
            setFailure(null);
            setEdit("capacity");
          }}
        >
          Change capacity
        </Button>
        <Button
          size="lg"
          disabled={!editable}
          onClick={() => {
            setExpiry(toDateInputValue(addDays(invite.expiresAt, 7)));
            setFailure(null);
            setEdit("expiry");
          }}
        >
          Extend expiry
        </Button>
        <Button
          size="lg"
          variant="danger"
          disabled={!editable}
          onClick={() => setConfirmRevoke(true)}
        >
          Revoke invite
        </Button>
        <CampaignRevocation campaignId={invite.campaignId} label={invite.label} />
      </div>
      {!editable ? (
        <p className="m-0 text-[13px] text-sym-muted">
          Revoked on {formatDateTime(invite.revokedAt ?? invite.createdAt)}. Accounts admitted with
          this code keep their access; relock them in{" "}
          <Link className="text-sym-link underline-offset-2 hover:underline" href="/admin/accounts">
            Accounts
          </Link>{" "}
          if that is what you need.
        </p>
      ) : null}

      <section aria-labelledby="redemptions-title" className="flex flex-col gap-3">
        <h2 id="redemptions-title" className="m-0 font-heading font-semibold text-[15px]">
          Redemptions
        </h2>
        {redemptions.length === 0 ? (
          <p className="m-0 text-[13.5px] text-sym-muted">
            No one has used this code yet. Seats are claimed only when someone redeems it.
          </p>
        ) : (
          <DataTable>
            <caption className="sr-only">Accounts that redeemed this code</caption>
            <thead>
              <tr>
                <HeadCell>Seat</HeadCell>
                <HeadCell>Account</HeadCell>
                <HeadCell>Redeemed</HeadCell>
                <HeadCell>Access from this seat</HeadCell>
              </tr>
            </thead>
            <tbody>
              {redemptions.map((redemption) => (
                <Row key={redemption.id}>
                  <Cell label="Seat">{redemption.seatNo}</Cell>
                  <Cell label="Account">
                    {redemption.email ? (
                      <Link
                        className="text-sym-link underline-offset-2 hover:underline"
                        href={`/admin/accounts/${redemption.userId}`}
                      >
                        {redemption.displayName
                          ? `${redemption.displayName} · ${redemption.email}`
                          : redemption.email}
                      </Link>
                    ) : (
                      "Deleted account"
                    )}
                  </Cell>
                  <Cell label="Redeemed">{formatDateTime(redemption.redeemedAt)}</Cell>
                  <Cell label="Access">
                    {redemption.grant === "current"
                      ? "Current"
                      : redemption.grant === "revoked"
                        ? "Revoked"
                        : "Not finalized"}
                  </Cell>
                </Row>
              ))}
            </tbody>
          </DataTable>
        )}
      </section>

      <Dialog open={edit !== null} onOpenChange={(open) => (open ? null : setEdit(null))}>
        <DialogContent>
          <DialogTitle>
            {edit === "capacity" ? "Change how many can redeem" : "Extend the expiry"}
          </DialogTitle>
          <DialogDescription>
            {edit === "capacity"
              ? `This code has ${invite.used} of ${invite.maxRedemptions} seats used. A cap never goes below the seats already claimed, and usage is never reset.`
              : `Codes can be valid for up to ${inviteMaxExpiryDays} days from today. An expired code becomes usable again when you move its expiry later.`}
          </DialogDescription>
          {edit === "capacity" ? (
            <TextField
              label="Maximum redemptions"
              type="number"
              min={Math.max(1, invite.used)}
              step={1}
              inputMode="numeric"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />
          ) : (
            <TextField
              label="New expiry date"
              type="date"
              value={expiry}
              min={toDateInputValue(Date.now())}
              max={toDateInputValue(addDays(Date.now(), inviteMaxExpiryDays - 1))}
              onChange={(event) => setExpiry(event.target.value)}
              description={`Currently ${formatDateTime(invite.expiresAt)}.`}
            />
          )}
          {failure ? (
            <Notice
              tone="error"
              actions={
                failure.reload ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      setEdit(null);
                      setFailure(null);
                      detail.reload();
                    }}
                  >
                    Reload invite
                  </Button>
                ) : null
              }
            >
              {failure.message}
            </Notice>
          ) : null}
          <DialogActions>
            <Button variant="secondary" size="lg" disabled={busy} onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="lg"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => {
                void (edit === "capacity" ? saveCapacity() : saveExpiry());
              }}
            >
              {busy ? <Spinner size={12} /> : null}
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="Revoke this invite?"
        description="No one can redeem this code afterwards. People already admitted with it keep their access — relock an account in Accounts to take access away."
        confirmLabel={busy ? "Revoking…" : "Revoke invite"}
        busy={busy}
        initialFocus="cancel"
        onConfirm={() => {
          void revoke();
        }}
      />
    </div>
  );
}
