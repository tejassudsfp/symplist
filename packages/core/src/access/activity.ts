import type {
  AdminEvent,
  AdminEventAction,
  AdminEventDetail,
  AdminEventPage,
  ListActivityQuery,
} from "@symplist/contracts";
import { adminEventActions, pageLimitDefault } from "@symplist/contracts";
import type { KeyProvider } from "@symplist/crypto";
import type { DbClient, DbRow, SqlParams } from "@symplist/db";
import { int, sql } from "@symplist/db";
import { AccessFeatureError } from "./feature-error.ts";
import {
  adminReasonContext,
  decryptTextOrNull,
  inviteLabelContext,
  loadKeyRing,
} from "./fields.ts";
import {
  decodeCursor,
  encodeCursor,
  enumColumn,
  integerColumn,
  jsonObjectColumn,
  nullableTextColumn,
  textColumn,
} from "./rows.ts";

/**
 * The event columns with the labels an audit row shows: the actor's email, the target account's
 * email or the target invite's hint. Deleted accounts join nothing, so their labels are null.
 */
export const adminEventSelect = `SELECT e.id, e.created_at, e.actor_kind, e.actor_id, e.action, e.target_kind,
    e.target_id, e.reason_enc, e.reason_owner_id, e.before_json, e.after_json,
    actor.email AS actor_email,
    CASE WHEN e.target_kind = 'user' THEN target_user.email
         WHEN e.target_kind = 'invite' THEN target_invite.hint
         ELSE NULL END AS target_label
  FROM beta_admin_events e
    LEFT JOIN users actor ON actor.id = e.actor_id
    LEFT JOIN users target_user ON e.target_kind = 'user' AND target_user.id = e.target_id
    LEFT JOIN beta_invites target_invite ON e.target_kind = 'invite' AND target_invite.id = e.target_id`;

/** Maps an {@link adminEventSelect} row; events of actions this build does not know are skipped. */
export function adminEventFromRow(row: DbRow): AdminEvent | null {
  const action = row.action;
  if (typeof action !== "string" || !(adminEventActions as readonly string[]).includes(action)) {
    return null;
  }
  return {
    id: textColumn(row, "id"),
    createdAt: integerColumn(row, "created_at"),
    actor: {
      kind: enumColumn(row, "actor_kind", ["user", "admin", "system"]),
      id: nullableTextColumn(row, "actor_id"),
      email: nullableTextColumn(row, "actor_email"),
    },
    action: action as AdminEventAction,
    target: {
      kind: enumColumn(row, "target_kind", ["user", "invite", "campaign", "system"]),
      id: nullableTextColumn(row, "target_id"),
      label: nullableTextColumn(row, "target_label"),
    },
    before: jsonObjectColumn(row, "before_json"),
    after: jsonObjectColumn(row, "after_json"),
    hasReason: row.reason_enc !== null,
    campaign: null,
  };
}

/** The campaign an event concerns: its target, or the `campaignId` recorded in its after values. */
function eventCampaignId(event: AdminEvent): string | null {
  if (event.target.kind === "campaign") return event.target.id;
  const value = event.after?.campaignId;
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value) ? value : null;
}

/**
 * Attaches each event's campaign with its decrypted label, reading one labelled invite per campaign
 * and the label owners' keys in two batches.
 */
export async function withCampaignLabels(
  db: DbClient,
  keys: KeyProvider,
  events: readonly AdminEvent[],
): Promise<AdminEvent[]> {
  const campaignIds = [
    ...new Set(events.map(eventCampaignId).filter((id): id is string => id !== null)),
  ];
  if (campaignIds.length === 0) return [...events];
  const statements = [];
  for (let offset = 0; offset < campaignIds.length; offset += 90) {
    statements.push(
      sql(
        `SELECT i.campaign_id, i.id, i.label_enc, i.label_owner_id FROM beta_invites i
         WHERE i.campaign_id IN (:campaigns) AND i.label_enc IS NOT NULL
           AND i.id = (SELECT MIN(j.id) FROM beta_invites j
                       WHERE j.campaign_id = i.campaign_id AND j.label_enc IS NOT NULL)`,
        { campaigns: campaignIds.slice(offset, offset + 90) },
      ),
    );
  }
  const rows = (await db.batch(statements)).flatMap((result) => result.results);
  const ring = await loadKeyRing(
    db,
    keys,
    rows.map((row) => nullableTextColumn(row, "label_owner_id")),
  );
  try {
    const labels = new Map<string, string | null>();
    for (const row of rows) {
      const owner = nullableTextColumn(row, "label_owner_id");
      labels.set(
        textColumn(row, "campaign_id"),
        owner
          ? decryptTextOrNull(
              ring.get(owner),
              inviteLabelContext(owner, textColumn(row, "id")),
              row.label_enc,
            )
          : null,
      );
    }
    return events.map((event) => {
      const id = eventCampaignId(event);
      return id ? { ...event, campaign: { id, label: labels.get(id) ?? null } } : event;
    });
  } finally {
    ring.dispose();
  }
}

export interface ActivityServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
}

/**
 * The immutable access audit log (§5.4, admin activity brief): newest first with filters, and one
 * event with its reason decrypted under the target account's key. There is no edit or delete.
 */
export class ActivityService {
  constructor(private readonly options: ActivityServiceOptions) {}

  async list(query: ListActivityQuery): Promise<AdminEventPage> {
    const limit = query.limit ?? pageLimitDefault;
    const conditions: string[] = [];
    const params: Record<string, string> = { page: int(limit + 1) };
    if (query.action) {
      conditions.push("e.action = :action");
      params.action = query.action;
    }
    if (query.actorId) {
      conditions.push("e.actor_id = :actor");
      params.actor = query.actorId;
    }
    if (query.accountId) {
      conditions.push(
        "(e.actor_id = :account OR (e.target_kind = 'user' AND e.target_id = :account))",
      );
      params.account = query.accountId;
    }
    if (query.inviteId) {
      conditions.push("e.target_kind = 'invite' AND e.target_id = :invite");
      params.invite = query.inviteId;
    }
    if (query.campaignId) {
      conditions.push(
        "((e.target_kind = 'campaign' AND e.target_id = :campaign) OR json_extract(e.after_json, '$.campaignId') = :campaign)",
      );
      params.campaign = query.campaignId;
    }
    if (query.from !== undefined) {
      conditions.push("e.created_at >= CAST(:from AS INTEGER)");
      params.from = int(query.from);
    }
    if (query.to !== undefined) {
      conditions.push("e.created_at < CAST(:to AS INTEGER)");
      params.to = int(query.to);
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      conditions.push(
        "(e.created_at < CAST(:cursor_t AS INTEGER) OR (e.created_at = CAST(:cursor_t AS INTEGER) AND e.id < :cursor_i))",
      );
      params.cursor_t = int(cursor.t);
      params.cursor_i = cursor.i;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.options.db.all(
      sql(
        `${adminEventSelect} ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT CAST(:page AS INTEGER)`,
        params as SqlParams,
      ),
    );
    const events = rows.slice(0, limit);
    const items = await withCampaignLabels(
      this.options.db,
      this.options.keys,
      events.map(adminEventFromRow).filter((event) => event !== null),
    );
    const last = events.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ t: integerColumn(last, "created_at"), i: textColumn(last, "id") })
          : null,
    };
  }

  async detail(eventId: string): Promise<AdminEventDetail> {
    const row = await this.options.db.first(
      sql(`${adminEventSelect} WHERE e.id = :event`, { event: eventId }),
    );
    const parsed = row ? adminEventFromRow(row) : null;
    if (!row || !parsed) throw new AccessFeatureError("not_found");
    const [event = parsed] = await withCampaignLabels(this.options.db, this.options.keys, [parsed]);
    const owner = nullableTextColumn(row, "reason_owner_id");
    if (!owner || row.reason_enc === null) return { event, reason: null, reasonUnavailable: false };
    const ring = await loadKeyRing(this.options.db, this.options.keys, [owner]);
    try {
      const reason = decryptTextOrNull(
        ring.get(owner),
        adminReasonContext(owner, event.id),
        row.reason_enc,
      );
      return { event, reason, reasonUnavailable: reason === null };
    } finally {
      ring.dispose();
    }
  }
}
