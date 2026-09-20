import type { AdminEventAction } from "@symplist/contracts";
import type { Statement } from "@symplist/db";
import { int, json, sql } from "@symplist/db";
import type { StatementGuard } from "./sessions.ts";

/**
 * Appends to `beta_admin_events` (§5.4, §5.6): account ids only, never emails, codes or OTPs; the
 * reason is a field envelope under `reasonOwnerId`'s key; before and after values are plaintext
 * operational metadata. `request_id` is unique, so a retried append is a no-op.
 */
export interface AdminEventInsert {
  readonly id: string;
  readonly actorKind: "user" | "admin" | "system";
  readonly actorId: string | null;
  readonly action: AdminEventAction;
  readonly targetKind: "user" | "invite" | "campaign" | "system";
  readonly targetId: string | null;
  readonly reasonEnc: string | null;
  readonly reasonOwnerId: string | null;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  readonly requestId: string | null;
  readonly createdAt: number;
}

/**
 * The append, taking effect only while `guard` holds (the deciding statement of its batch applied).
 * Parameter names are prefixed `ev_` so the guard's own names never collide.
 */
export function adminEventInsertStatement(
  event: AdminEventInsert,
  guard: StatementGuard | null,
): Statement {
  if ((event.reasonEnc === null) !== (event.reasonOwnerId === null)) {
    throw new TypeError("An encrypted reason needs its owner, and an owner needs a reason");
  }
  const where = guard ? guard.exists : "1";
  return sql(
    `INSERT INTO beta_admin_events
       (id, actor_kind, actor_id, action, target_kind, target_id, reason_enc, reason_owner_id,
        before_json, after_json, request_id, created_at)
     SELECT :ev_id, :ev_actor_kind, :ev_actor_id, :ev_action, :ev_target_kind, :ev_target_id,
            :ev_reason, :ev_reason_owner, :ev_before, :ev_after, :ev_request, :ev_now
     WHERE ${where}
     ON CONFLICT DO NOTHING`,
    {
      ...guard?.params,
      ev_id: event.id,
      ev_actor_kind: event.actorKind,
      ev_actor_id: event.actorId,
      ev_action: event.action,
      ev_target_kind: event.targetKind,
      ev_target_id: event.targetId,
      ev_reason: event.reasonEnc,
      ev_reason_owner: event.reasonOwnerId,
      ev_before: event.before === null ? null : json(event.before),
      ev_after: event.after === null ? null : json(event.after),
      ev_request: event.requestId,
      ev_now: int(event.createdAt),
    },
  );
}

/** A guard that holds only in the batch whose users update set `writeId`. */
export function usersWriteGuard(userId: string, writeId: string): StatementGuard {
  return Object.freeze({
    exists: "EXISTS (SELECT 1 FROM users WHERE id = :guard_user AND write_id = :guard_write_id)",
    params: Object.freeze({ guard_user: userId, guard_write_id: writeId }),
  });
}
