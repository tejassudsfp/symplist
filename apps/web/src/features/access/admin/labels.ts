import type {
  AdminAccount,
  AdminEvent,
  AdminEventAction,
  InviteStatus,
  RestrictionReason,
} from "@symplist/contracts";

/** Invite statuses as the inventory shows them (admin_invites.md). */
export const inviteStatusLabels: Record<InviteStatus, string> = {
  active: "Active",
  exhausted: "Exhausted",
  expired: "Expired",
  revoked: "Revoked",
};

/** Beta access of one account in the administration list (admin_accounts.md). */
export type AccountStateId = "pending" | "locked" | "unlocked" | "paused" | "deleting";

export function accountState(account: AdminAccount): AccountStateId {
  if (account.deletionState !== "none") return "deleting";
  if (account.emailVerifiedAt === null) return "pending";
  if (account.suspendedAt !== null || account.betaState === "relocked") return "paused";
  return account.betaState === "unlocked" ? "unlocked" : "locked";
}

export const accountStateLabels: Record<AccountStateId, string> = {
  pending: "Pending verification",
  locked: "Locked",
  unlocked: "Unlocked",
  paused: "Paused",
  deleting: "Being deleted",
};

export const onboardingLabels: Record<AdminAccount["onboardingStep"], string> = {
  name: "Not started",
  connections: "Connections step",
  done: "Finished",
};

export const grantSourceLabels = {
  invite: "Invite code",
  admin: "Administrator",
} as const;

export const restrictionReasonLabels: Record<RestrictionReason, string> = {
  relocked: "Relocked by an administrator",
  suspended: "Account suspended",
  deleted: "Account deleted",
  campaign_revoked: "Campaign access revoked",
};

/** Verbs for the audit log, used in "Maya redeemed Friends — September" (admin_activity.md). */
export const eventActionLabels: Record<AdminEventAction, string> = {
  invite_generated: "generated codes",
  invite_redeemed: "redeemed",
  invite_capacity_changed: "changed capacity",
  invite_expiry_extended: "extended expiry",
  invite_revoked: "revoked invite",
  account_unlocked: "unlocked account",
  access_relocked: "relocked access",
  eligibility_restored: "restored eligibility",
  access_restored: "restored access",
  campaign_access_revoked: "revoked campaign access",
  admin_bootstrap: "became the first administrator",
  admin_rebootstrap: "was made an administrator again",
};

/** The short action name used in filters. */
export const eventActionFilterLabels: Record<AdminEventAction, string> = {
  invite_generated: "Codes generated",
  invite_redeemed: "Code redeemed",
  invite_capacity_changed: "Capacity changed",
  invite_expiry_extended: "Expiry extended",
  invite_revoked: "Invite revoked",
  account_unlocked: "Account unlocked",
  access_relocked: "Access relocked",
  eligibility_restored: "Eligibility restored",
  access_restored: "Access restored",
  campaign_access_revoked: "Campaign revoked",
  admin_bootstrap: "Admin bootstrap",
  admin_rebootstrap: "Admin re-bootstrap",
};

/** How an actor is named: an address, the system, or a deleted account (§5.6). */
export function actorName(event: AdminEvent): string {
  if (event.actor.kind === "system") return "Symplist";
  return event.actor.email ?? "Deleted account";
}

/** How a target is named: an address, an invite hint, a campaign label, or nothing. */
export function targetName(event: AdminEvent): string | null {
  if (event.target.kind === "system") return null;
  if (event.target.label) return event.target.label;
  return event.target.kind === "user" ? "Deleted account" : null;
}

/** "Maya redeemed Friends — September": one readable line per audit row. */
export function eventSentence(event: AdminEvent): string {
  const actor = actorName(event);
  const verb = eventActionLabels[event.action];
  const campaign = event.campaign?.label ?? null;
  const target = targetName(event);
  if (event.action === "invite_redeemed") {
    return `${actor} redeemed ${campaign ?? target ?? "an invite code"}`;
  }
  if (event.action === "invite_generated") {
    const count = typeof event.after?.count === "number" ? event.after.count : null;
    const what = campaign ? ` for ${campaign}` : "";
    return count === null
      ? `${actor} ${verb}${what}`
      : `${actor} generated ${count === 1 ? "1 code" : `${count} codes`}${what}`;
  }
  if (event.action === "invite_capacity_changed") {
    const from = event.before?.maxRedemptions;
    const to = event.after?.maxRedemptions;
    const name = campaign ?? target;
    const suffix = name ? ` for ${name}` : "";
    if (typeof from === "number" && typeof to === "number") {
      const direction = to > from ? "increased" : "reduced";
      return `${actor} ${direction} capacity from ${from} to ${to}${suffix}`;
    }
    return `${actor} ${verb}${suffix}`;
  }
  return target ? `${actor} ${verb} · ${target}` : `${actor} ${verb}`;
}

/**
 * The short result of an event for the log's last column: what the recorded values changed to, from
 * plaintext operational fields only (never secrets or content).
 */
export function eventResult(event: AdminEvent): string {
  const after = event.after ?? {};
  const before = event.before ?? {};
  const keys = Object.keys(after);
  if (keys.length === 0) return "—";
  return keys
    .slice(0, 3)
    .map((key) => {
      const to = formatEventValue(after[key]);
      const from = key in before ? formatEventValue(before[key]) : null;
      const name = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
      return from === null || from === to ? `${name} ${to}` : `${name} ${from} → ${to}`;
    })
    .join(", ");
}

/** Plain text for one before/after value in the event detail. */
export function formatEventValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
