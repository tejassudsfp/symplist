import { randomBytes } from "node:crypto";
import type {
  AdminInvite,
  AdminInviteDetail,
  AdminInvitePage,
  AdminRedemption,
  GenerateInvitesRequest,
  GenerateInvitesResponse,
  InviteStatus,
  ListInvitesQuery,
} from "@symplist/contracts";
import {
  formatInviteCode,
  inviteCodeAlphabet,
  inviteCodeHint,
  inviteMaxExpiryDays,
  normalizeInviteCode,
  pageLimitDefault,
} from "@symplist/contracts";
import type { AccountDataKey, KeyProvider } from "@symplist/crypto";
import { computeDigest } from "@symplist/crypto";
import type { DbClient, DbRow, Statement, StatementResult } from "@symplist/db";
import { int, json, sql, uuidv7 } from "@symplist/db";
import { adminEventInsertStatement } from "./admin-events.ts";
import type { AccessPolicy } from "./evaluate.ts";
import { AccessFeatureError } from "./feature-error.ts";
import {
  decryptTextOrNull,
  displayNameContext,
  encryptText,
  inviteLabelContext,
  type KeyRing,
  loadKeyRing,
} from "./fields.ts";
import {
  decodeCursor,
  encodeCursor,
  enumColumn,
  integerColumn,
  nullableIntegerColumn,
  nullableTextColumn,
  textColumn,
} from "./rows.ts";
import type { StatementGuard } from "./sessions.ts";
import { accessCondition } from "./sql.ts";

/** Random bytes behind each code: 160 bits (note 04). */
export const INVITE_CODE_BYTES = 20;

/** RFC 4648 Base32 without padding. */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += inviteCodeAlphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += inviteCodeAlphabet[(value << (5 - bits)) & 31];
  return output;
}

/** A new canonical code from a cryptographically secure source (32 Base32 characters). */
export function generateInviteCode(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(INVITE_CODE_BYTES);
  if (bytes.byteLength !== INVITE_CODE_BYTES)
    throw new Error("The random source returned too few bytes");
  try {
    return encodeBase32(bytes);
  } finally {
    bytes.fill(0);
  }
}

/** The status of an invite at `now`, derived from its fields and used seats (§5.4). */
export function inviteStatus(
  invite: { revokedAt: number | null; expiresAt: number; used: number; maxRedemptions: number },
  now: number,
): InviteStatus {
  if (invite.revokedAt !== null) return "revoked";
  if (invite.expiresAt <= now) return "expired";
  if (invite.used >= invite.maxRedemptions) return "exhausted";
  return "active";
}

const inviteColumns = `i.id, i.campaign_id, i.mode, i.hint, i.label_enc, i.label_owner_id, i.bound_email,
  i.max_redemptions, i.expires_at, i.created_by, i.created_at, i.revoked_at, i.version,
  (SELECT COUNT(*) FROM beta_redemptions r WHERE r.invite_id = i.id) AS used`;

/**
 * Rows one admin invite search reads per request, and the most it reads in all. A search cannot be
 * pushed into SQL — an invite's label is encrypted, so it only matches after it is decrypted — so
 * the scan reads pages and filters them here. It used to read 200 rows at a time and load a key ring
 * for each page, which made one search up to ten reads and ten key-ring batches: about twenty D1
 * requests against the api's 2 req/s lane (§3.1, "never a query in a loop"). It now reads at most
 * four pages and loads one key ring for all of them, so a search costs at most five requests
 * whatever the table holds, and two for a table that fits in a page. Reach and order are unchanged:
 * the scan still stops early, and every row it read is decrypted, so a label match among them keeps
 * its place. `nextCursor` continues a scan that ran out of budget, as before.
 */
const INVITE_SEARCH_SCAN_PAGE = 500;
const INVITE_SEARCH_SCAN_MAX = 2_000;

/** The two forms an invite search takes: a lower-case substring, and a code or hint's last letters. */
interface InviteSearchTerms {
  readonly lower: string;
  readonly letters: string;
}

function inviteSearchTerms(search: string): InviteSearchTerms {
  const canonical = normalizeInviteCode(search);
  let letters = canonical ? canonical.slice(-4) : search.toUpperCase().replace(/[^A-Z2-7]/g, "");
  // A hint as displayed (`SYM-…-WXYZ`) or typed without the prefix.
  if (!canonical && letters.startsWith("SYM") && letters.length > 3) letters = letters.slice(3);
  return { lower: search.toLowerCase(), letters };
}

/** The half of the match that reads plain columns, so it runs before any key ring is loaded. */
function matchesUnencrypted(
  invite: { readonly hint: string; readonly boundEmail: string | null },
  terms: InviteSearchTerms,
): boolean {
  return (
    (terms.letters.length >= 2 &&
      terms.letters.length <= 4 &&
      invite.hint.includes(terms.letters)) ||
    (invite.boundEmail?.includes(terms.lower) ?? false)
  );
}

const statusConditions: Readonly<Record<InviteStatus, string>> = {
  revoked: "i.revoked_at IS NOT NULL",
  expired: "i.revoked_at IS NULL AND i.expires_at <= CAST(:now AS INTEGER)",
  exhausted: `i.revoked_at IS NULL AND i.expires_at > CAST(:now AS INTEGER)
    AND (SELECT COUNT(*) FROM beta_redemptions r WHERE r.invite_id = i.id) >= i.max_redemptions`,
  active: `i.revoked_at IS NULL AND i.expires_at > CAST(:now AS INTEGER)
    AND (SELECT COUNT(*) FROM beta_redemptions r WHERE r.invite_id = i.id) < i.max_redemptions`,
};

export interface InviteAdminServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  /** Test seam for the code source; production uses `crypto.randomBytes`. */
  readonly random?: (size: number) => Uint8Array;
}

export interface GenerationPlan {
  /** The invite inserts and the audit event, each guarded by the caller's claim. */
  readonly statements: readonly Statement[];
  /** The minting response: `codes` exist only here and in the HTTP response (§6.1). */
  readonly response: Extract<GenerateInvitesResponse, { secretUnavailable: false }>;
}

export type InviteEdit =
  | { readonly kind: "capacity"; readonly maxRedemptions: number }
  | { readonly kind: "expiry"; readonly expiresAt: number }
  | { readonly kind: "revoke" };

/**
 * Beta invite administration (note 04): generation with one-time codes, the inventory with status
 * filters and search, invite detail with redemptions, and the capacity, expiry and revocation edits.
 * Every edit is one conditional batch whose audit event gates the update.
 */
export class InviteAdminService {
  constructor(private readonly options: InviteAdminServiceOptions) {}

  /**
   * Builds the generation batch (§5.4, §6.1). Codes are drawn here; only their digests (under the
   * current `INVITE_DIGEST_SECRET`) and four-character hints are written, labels are encrypted with
   * the administrator's key, and every statement is guarded by `guard` (the folded idempotency claim),
   * so one request mints exactly once.
   */
  planGeneration(input: {
    readonly adminId: string;
    readonly adminKey: AccountDataKey;
    readonly request: GenerateInvitesRequest;
    readonly guard: StatementGuard;
  }): GenerationPlan {
    const { keys } = this.options;
    const now = this.options.now();
    const { request } = input;
    const maxExpiry = now + inviteMaxExpiryDays * 24 * 60 * 60 * 1000;
    if (request.expiresAt <= now + 60_000 || request.expiresAt > maxExpiry) {
      throw new AccessFeatureError("invite.expiry_invalid");
    }
    const campaignId = uuidv7(now);
    const writeId = uuidv7(now);
    const rows: { id: string; digest: string; hint: string; label: string | null }[] = [];
    const codes: GenerationPlan["response"]["codes"] = [];
    const invites: AdminInvite[] = [];
    let digestVersion = 0;
    for (let index = 0; index < request.count; index += 1) {
      const id = uuidv7(now);
      const canonical = generateInviteCode(this.options.random);
      const digest = computeDigest(keys, "INVITE_DIGEST_SECRET", "invite", canonical);
      digestVersion = digest.version;
      const hint = inviteCodeHint(canonical);
      rows.push({
        id,
        digest: digest.digest,
        hint,
        label:
          request.label === undefined
            ? null
            : encryptText(input.adminKey, inviteLabelContext(input.adminId, id), request.label),
      });
      codes.push(formatInviteCode(canonical));
      invites.push({
        id: id as AdminInvite["id"],
        campaignId,
        mode: request.mode,
        label: request.label ?? null,
        hint,
        status: "active",
        used: 0,
        maxRedemptions: request.maxRedemptions,
        remaining: request.maxRedemptions,
        boundEmail: request.boundEmail ?? null,
        expiresAt: request.expiresAt,
        createdAt: now,
        createdBy: input.adminId,
        revokedAt: null,
        version: 1,
      });
    }
    const statements: Statement[] = [
      sql(
        `INSERT INTO beta_invites
           (id, campaign_id, mode, digest, digest_version, hint, label_enc, label_owner_id, bound_email,
            max_redemptions, expires_at, created_by, created_at, revoked_at, revoked_by, version,
            updated_at, write_id)
         SELECT json_extract(value, '$.id'), :campaign, :mode, json_extract(value, '$.digest'),
                CAST(:digest_version AS INTEGER), json_extract(value, '$.hint'),
                json_extract(value, '$.label'), CASE WHEN json_extract(value, '$.label') IS NULL THEN NULL ELSE :admin END,
                :bound, CAST(:max AS INTEGER), CAST(:expires AS INTEGER), :admin, CAST(:now AS INTEGER),
                NULL, NULL, 1, CAST(:now AS INTEGER), :w
         FROM json_each(:rows) WHERE ${input.guard.exists}`,
        {
          ...input.guard.params,
          campaign: campaignId,
          mode: request.mode,
          digest_version: int(digestVersion),
          admin: input.adminId,
          bound: request.boundEmail ?? null,
          max: int(request.maxRedemptions),
          expires: int(request.expiresAt),
          now: int(now),
          w: writeId,
          rows: json(rows),
        },
      ),
      adminEventInsertStatement(
        {
          id: uuidv7(now),
          actorKind: "admin",
          actorId: input.adminId,
          action: "invite_generated",
          targetKind: "campaign",
          targetId: campaignId,
          reasonEnc: null,
          reasonOwnerId: null,
          before: null,
          after: {
            campaignId,
            mode: request.mode,
            count: request.count,
            maxRedemptions: request.maxRedemptions,
            expiresAt: request.expiresAt,
            emailBound: request.boundEmail !== undefined,
            hints: rows.map((row) => row.hint),
          },
          requestId: `invite_generated:${campaignId}`,
          createdAt: now,
        },
        input.guard,
      ),
    ];
    return { statements, response: { campaignId, invites, codes, secretUnavailable: false } };
  }

  /** `GET /v1/admin/invites`: newest first, filtered by status and campaign, searched by hint, email or label. */
  async list(query: ListInvitesQuery): Promise<AdminInvitePage> {
    const now = this.options.now();
    const limit = query.limit ?? pageLimitDefault;
    let cursor = decodeCursor(query.cursor);
    const search = query.q?.trim();
    const terms = search ? inviteSearchTerms(search) : null;
    const scanPage = search ? INVITE_SEARCH_SCAN_PAGE : limit + 1;
    const maxScanned = search ? INVITE_SEARCH_SCAN_MAX : limit + 1;
    const scannedRows: DbRow[] = [];
    let scanned = 0;
    let exhausted = false;
    // Matches on the fields that need no key. Enough of them ends the scan: they are read in the
    // page's own order, so a label match past the last one read cannot reach this page either.
    let unencryptedMatches = 0;
    while (scanned < maxScanned && !exhausted && unencryptedMatches <= limit) {
      const conditions: string[] = [];
      const params: Record<string, string | null> = {
        now: int(now),
        page: int(scanPage),
      };
      if (query.status) conditions.push(statusConditions[query.status]);
      if (query.campaignId) {
        conditions.push("i.campaign_id = :campaign");
        params.campaign = query.campaignId;
      }
      if (cursor) {
        conditions.push(
          "(i.created_at < CAST(:cursor_t AS INTEGER) OR (i.created_at = CAST(:cursor_t AS INTEGER) AND i.id < :cursor_i))",
        );
        params.cursor_t = int(cursor.t);
        params.cursor_i = cursor.i;
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      if (!where.includes(":now")) delete params.now;
      const rows = await this.options.db.all(
        sql(
          `SELECT ${inviteColumns} FROM beta_invites i ${where}
           ORDER BY i.created_at DESC, i.id DESC LIMIT CAST(:page AS INTEGER)`,
          params,
        ),
      );
      scanned += rows.length;
      if (rows.length < scanPage) exhausted = true;
      for (const row of rows) {
        scannedRows.push(row);
        cursor = { t: integerColumn(row, "created_at"), i: textColumn(row, "id") };
        if (!terms) continue;
        if (
          matchesUnencrypted(
            { hint: textColumn(row, "hint"), boundEmail: nullableTextColumn(row, "bound_email") },
            terms,
          )
        ) {
          unencryptedMatches += 1;
          if (unencryptedMatches > limit) break;
        }
      }
    }

    // One key ring for the whole scan, not one per page: a ring is a D1 batch of its own (§3.1).
    const ring = await loadKeyRing(
      this.options.db,
      this.options.keys,
      scannedRows.map((row) => nullableTextColumn(row, "label_owner_id")),
    );
    const matched: AdminInvite[] = [];
    try {
      for (const row of scannedRows) {
        const invite = this.inviteFromRow(row, ring, now);
        if (!terms || this.matches(invite, terms)) {
          matched.push(invite);
          if (matched.length > limit) break;
        }
      }
    } finally {
      ring.dispose();
    }
    const items = matched.slice(0, limit);
    const last = items.at(-1);
    let nextCursor: string | null = null;
    if (matched.length > limit && last) {
      nextCursor = encodeCursor({ t: last.createdAt, i: last.id });
    } else if (!exhausted && cursor) {
      // The search budget ended before the list did: continue scanning from the last row read.
      nextCursor = encodeCursor(cursor);
    }
    return { items, nextCursor };
  }

  private matches(invite: AdminInvite, terms: InviteSearchTerms): boolean {
    return (
      matchesUnencrypted(invite, terms) ||
      (invite.label?.toLowerCase().includes(terms.lower) ?? false)
    );
  }

  /** `GET /v1/admin/invites/:id` with its seats; unknown ids are `not_found`. */
  async detail(inviteId: string): Promise<AdminInviteDetail> {
    const now = this.options.now();
    const results = await this.options.db.batch([
      sql(`SELECT ${inviteColumns} FROM beta_invites i WHERE i.id = :invite`, { invite: inviteId }),
      sql(
        `SELECT r.id, r.seat_no, r.user_id, r.access_epoch, r.redeemed_at, u.email, u.display_name_enc,
           CASE
             WHEN EXISTS (SELECT 1 FROM beta_access_grants g WHERE g.source = 'invite' AND g.source_id = r.id AND g.revoked_at IS NULL) THEN 'current'
             WHEN EXISTS (SELECT 1 FROM beta_access_grants g WHERE g.source = 'invite' AND g.source_id = r.id) THEN 'revoked'
             ELSE 'none'
           END AS grant_state
         FROM beta_redemptions r LEFT JOIN users u ON u.id = r.user_id
         WHERE r.invite_id = :invite ORDER BY r.seat_no LIMIT 500`,
        { invite: inviteId },
      ),
    ]);
    const row = results[0]?.results[0];
    if (!row) throw new AccessFeatureError("not_found");
    const redemptionRows = results[1]?.results ?? [];
    const ring = await loadKeyRing(this.options.db, this.options.keys, [
      nullableTextColumn(row, "label_owner_id"),
      ...redemptionRows.map((redemption) => textColumn(redemption, "user_id")),
    ]);
    try {
      return {
        invite: this.inviteFromRow(row, ring, now),
        redemptions: redemptionRows.map((redemption): AdminRedemption => {
          const userId = textColumn(redemption, "user_id");
          return {
            id: textColumn(redemption, "id"),
            seatNo: integerColumn(redemption, "seat_no"),
            userId,
            email: nullableTextColumn(redemption, "email"),
            displayName: decryptTextOrNull(
              ring.get(userId),
              displayNameContext(userId),
              redemption.display_name_enc,
            ),
            accessEpoch: integerColumn(redemption, "access_epoch"),
            redeemedAt: integerColumn(redemption, "redeemed_at"),
            grant: enumColumn(redemption, "grant_state", ["current", "revoked", "none"]),
          };
        }),
      };
    } finally {
      ring.dispose();
    }
  }

  /**
   * One conditional edit (capacity, expiry or revocation). The audit event is inserted only while the
   * invite is at `expectedVersion`, not revoked and the edit is valid, and the update applies only when
   * that event was inserted, so a retried request (same `requestId`) changes nothing twice. A refused
   * edit is explained from a fresh read.
   */
  async edit(input: {
    readonly adminId: string;
    readonly inviteId: string;
    readonly expectedVersion: number;
    readonly edit: InviteEdit;
    readonly requestId: string;
  }): Promise<AdminInvite> {
    const { db, policy } = this.options;
    const now = this.options.now();
    const eventId = uuidv7(now);
    const writeId = uuidv7(now);
    const actorCondition = accessCondition({ level: "admin", policy, userParam: "actor" });
    const base = {
      invite: input.inviteId,
      expected: int(input.expectedVersion),
      now: int(now),
      actor: input.adminId,
    };
    let validity: string;
    let set: string;
    let action: "invite_capacity_changed" | "invite_expiry_extended" | "invite_revoked";
    let beforeJson: string;
    let afterJson: string;
    const extra: Record<string, string> = {};
    switch (input.edit.kind) {
      case "capacity":
        validity = `(SELECT COUNT(*) FROM beta_redemptions r WHERE r.invite_id = i.id) <= CAST(:max AS INTEGER)`;
        set = "max_redemptions = CAST(:max AS INTEGER)";
        action = "invite_capacity_changed";
        beforeJson = `json_object('maxRedemptions', i.max_redemptions, 'used', (SELECT COUNT(*) FROM beta_redemptions r WHERE r.invite_id = i.id), 'campaignId', i.campaign_id)`;
        afterJson = `json_object('maxRedemptions', CAST(:max AS INTEGER), 'campaignId', i.campaign_id)`;
        extra.max = int(input.edit.maxRedemptions);
        break;
      case "expiry": {
        const maxExpiry = now + inviteMaxExpiryDays * 24 * 60 * 60 * 1000;
        if (input.edit.expiresAt <= now || input.edit.expiresAt > maxExpiry) {
          throw new AccessFeatureError("invite.expiry_invalid");
        }
        validity = "CAST(:expires AS INTEGER) > i.expires_at";
        set = "expires_at = CAST(:expires AS INTEGER)";
        action = "invite_expiry_extended";
        beforeJson = `json_object('expiresAt', i.expires_at, 'campaignId', i.campaign_id)`;
        afterJson = `json_object('expiresAt', CAST(:expires AS INTEGER), 'campaignId', i.campaign_id)`;
        extra.expires = int(input.edit.expiresAt);
        break;
      }
      case "revoke":
        validity = "1";
        set = "revoked_at = CAST(:now AS INTEGER), revoked_by = :actor";
        action = "invite_revoked";
        beforeJson = `json_object('revoked', json('false'), 'campaignId', i.campaign_id)`;
        afterJson = `json_object('revoked', json('true'), 'campaignId', i.campaign_id)`;
        break;
    }
    const eligible = `i.id = :invite AND i.version = CAST(:expected AS INTEGER) AND i.revoked_at IS NULL
      AND ${validity} AND ${actorCondition}`;
    const statements: Statement[] = [
      sql(
        `INSERT INTO beta_admin_events
           (id, actor_kind, actor_id, action, target_kind, target_id, reason_enc, reason_owner_id,
            before_json, after_json, request_id, created_at)
         SELECT :event, 'admin', :actor, :action, 'invite', i.id, NULL, NULL, ${beforeJson}, ${afterJson},
                :request, CAST(:now AS INTEGER)
         FROM beta_invites i WHERE ${eligible}
         ON CONFLICT DO NOTHING`,
        { ...base, ...extra, event: eventId, action, request: input.requestId },
      ),
      sql(
        `UPDATE beta_invites SET ${set}, version = version + 1, updated_at = CAST(:now AS INTEGER), write_id = :w
         WHERE id IN (SELECT i.id FROM beta_invites i WHERE ${eligible})
           AND EXISTS (SELECT 1 FROM beta_admin_events WHERE id = :event)`,
        { ...base, ...extra, event: eventId, w: writeId },
      ),
      sql(`SELECT ${inviteColumns} FROM beta_invites i WHERE i.id = :invite AND i.write_id = :w`, {
        invite: input.inviteId,
        w: writeId,
      }),
      sql(`SELECT ${inviteColumns} FROM beta_invites i WHERE i.id = :invite`, {
        invite: input.inviteId,
      }),
    ];
    const results: readonly StatementResult[] = await db.batch(statements);
    const updated = results[2]?.results[0];
    const current = results[3]?.results[0];
    if (!current) throw new AccessFeatureError("not_found");
    const ring = await loadKeyRing(db, this.options.keys, [
      nullableTextColumn(current, "label_owner_id"),
    ]);
    try {
      const invite = this.inviteFromRow(updated ?? current, ring, now);
      if (updated) return invite;
      if (invite.revokedAt !== null) throw new AccessFeatureError("invite.revoked");
      if (invite.version !== input.expectedVersion) {
        throw new AccessFeatureError("invite.changed", { version: invite.version });
      }
      if (input.edit.kind === "capacity" && invite.used > input.edit.maxRedemptions) {
        throw new AccessFeatureError("invite.capacity_below_used", { used: invite.used });
      }
      if (input.edit.kind === "expiry") throw new AccessFeatureError("invite.expiry_invalid");
      throw new AccessFeatureError("invite.changed", { version: invite.version });
    } finally {
      ring.dispose();
    }
  }

  private inviteFromRow(row: DbRow, ring: KeyRing, now: number): AdminInvite {
    const id = textColumn(row, "id");
    const labelOwner = nullableTextColumn(row, "label_owner_id");
    const used = integerColumn(row, "used");
    const maxRedemptions = integerColumn(row, "max_redemptions");
    const revokedAt = nullableIntegerColumn(row, "revoked_at");
    const expiresAt = integerColumn(row, "expires_at");
    return {
      id: id as AdminInvite["id"],
      campaignId: textColumn(row, "campaign_id"),
      mode: enumColumn(row, "mode", ["independent", "shared"]),
      label: labelOwner
        ? decryptTextOrNull(ring.get(labelOwner), inviteLabelContext(labelOwner, id), row.label_enc)
        : null,
      hint: textColumn(row, "hint"),
      status: inviteStatus({ revokedAt, expiresAt, used, maxRedemptions }, now),
      used,
      maxRedemptions,
      remaining: Math.max(0, maxRedemptions - used),
      boundEmail: nullableTextColumn(row, "bound_email"),
      expiresAt,
      createdAt: integerColumn(row, "created_at"),
      createdBy: textColumn(row, "created_by"),
      revokedAt,
      version: integerColumn(row, "version"),
    };
  }

  /** The label of a campaign (from any of its invites), for previews and activity; null when none. */
  async campaignLabel(campaignId: string): Promise<{ exists: boolean; label: string | null }> {
    const row = await this.options.db.first(
      sql(
        `SELECT id, label_enc, label_owner_id FROM beta_invites WHERE campaign_id = :campaign
         ORDER BY label_enc IS NULL, created_at LIMIT 1`,
        { campaign: campaignId },
      ),
    );
    if (!row) return { exists: false, label: null };
    const owner = nullableTextColumn(row, "label_owner_id");
    if (!owner) return { exists: true, label: null };
    const ring = await loadKeyRing(this.options.db, this.options.keys, [owner]);
    try {
      return {
        exists: true,
        label: decryptTextOrNull(
          ring.get(owner),
          inviteLabelContext(owner, textColumn(row, "id")),
          row.label_enc,
        ),
      };
    } finally {
      ring.dispose();
    }
  }
}
