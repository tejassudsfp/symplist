"use client";

import type { AccessState, MeResponse } from "@symplist/contracts";
import { cn } from "cn";

export type AccessLabelTone = "ok" | "waiting" | "paused" | "pending";

export interface AccessLabel {
  readonly text: string;
  readonly tone: AccessLabelTone;
  readonly detail: string;
}

/** A restrained beta-access indicator for the account screens (settings_account.md). */
export function accessLabel(access: AccessState, betaAccessRequired: boolean): AccessLabel {
  if (access.emailVerifiedAt === null) {
    return {
      text: "Email not verified",
      tone: "pending",
      detail: "Verify your email with a sign-in code to finish registering.",
    };
  }
  if (access.suspendedAt !== null) {
    return {
      text: "Paused",
      tone: "paused",
      detail: "This account is suspended. Only the operator can restore it.",
    };
  }
  if (access.betaState === "relocked") {
    return {
      text: "Paused",
      tone: "paused",
      detail: "An administrator paused beta access. A new invite code can't reopen it.",
    };
  }
  if (access.betaState === "unlocked" || !betaAccessRequired) {
    return {
      text: "Unlocked",
      tone: "ok",
      detail: betaAccessRequired
        ? "Beta access is unlocked for this account."
        : "This deployment doesn't require an invite code.",
    };
  }
  return {
    text: "Waiting for an invite",
    tone: "waiting",
    detail: "Symplist is in closed beta. An invite code unlocks the app.",
  };
}

const toneClass: Record<AccessLabelTone, string> = {
  ok: "bg-sym-ok-soft text-sym-text",
  waiting: "bg-sym-hover text-sym-text",
  paused: "bg-sym-warn-soft text-sym-text",
  pending: "bg-sym-hover text-sym-text",
};

export function AccessBadge({ label, className }: { label: AccessLabel; className?: string }) {
  return (
    <span
      data-slot="access-badge"
      data-tone={label.tone}
      className={cn(
        "inline-flex items-center rounded-sym px-2 py-0.5 font-medium text-[12.5px]",
        toneClass[label.tone],
        className,
      )}
    >
      {label.text}
    </span>
  );
}

/** Identity and access facts shown on every account screen. */
export function AccessSummary({ me }: { me: MeResponse }) {
  const label = accessLabel(me.access, me.betaAccessRequired);
  return (
    <dl className="m-0 grid gap-3 sm:grid-cols-[140px_1fr]" data-slot="account-summary">
      <dt className="m-0 font-medium text-[13px] text-sym-muted">Email</dt>
      <dd className="m-0 flex flex-wrap items-center gap-2 break-words text-[14px]">
        <span>{me.user.email}</span>
        {me.access.emailVerifiedAt === null ? (
          <span className="text-[12.5px] text-sym-muted">(not verified yet)</span>
        ) : (
          <span className="text-[12.5px] text-sym-muted">Verified</span>
        )}
      </dd>
      <dt className="m-0 font-medium text-[13px] text-sym-muted">Beta access</dt>
      <dd className="m-0 flex flex-col gap-1">
        <AccessBadge label={label} />
        <span className="text-[12.5px] text-sym-muted">{label.detail}</span>
      </dd>
      {me.user.role === "admin" ? (
        <>
          <dt className="m-0 font-medium text-[13px] text-sym-muted">Role</dt>
          <dd className="m-0 text-[14px]">Administrator</dd>
        </>
      ) : null}
    </dl>
  );
}
