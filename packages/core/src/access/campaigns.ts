import { createHash } from "node:crypto";
import type { CampaignRevocationPreview, CampaignRevocationResult } from "@symplist/contracts";
import type { KeyProvider } from "@symplist/crypto";
import { canonicalJson } from "@symplist/crypto";
import type { DbClient, DbRow, Statement } from "@symplist/db";
import { sql, uuidv7, verifiedRow } from "@symplist/db";
import { adminEventInsertStatement } from "./admin-events.ts";
import { AccessFeatureError } from "./feature-error.ts";
import {
  adminReasonContext,
  decryptTextOrNull,
  displayNameContext,
  encryptText,
  inviteLabelContext,
  loadKeyRing,
} from "./fields.ts";
import { MAX_RESTRICTIONS_PER_BATCH, type RestrictionCommitted } from "./restrict.ts";
import { integerColumn, nullableTextColumn, textColumn } from "./rows.ts";
import type { AccessService } from "./service.ts";
import { restrictGuard } from "./sql.ts";

export interface CampaignRevocationServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly now: () => number;
  readonly access: Pick<AccessService, "restrictStatements"> & {
    afterRestriction(event: RestrictionCommitted): Promise<void>;
  };
  /** Called after each committed restriction, for example to publish `access.changed`. */
  readonly onRestricted?: (userId: string, accessGeneration: number) => Promise<void>;
}

interface Member {
  readonly userId: string;
  readonly email: string;
  readonly displayNameEnc: string | null;
  readonly grantId: string;
  readonly grantedAt: number;
}

/** The digest of a campaign's membership: accounts with a current grant from the campaign. */
export function campaignPreviewDigest(campaignId: string, members: readonly Member[]): string {
  const pairs = members.map((member) => [member.userId, member.grantId]).sort();
  return createHash("sha256")
    .update(canonicalJson({ campaignId, grants: pairs }))
    .digest("hex");
}

/**
 * Campaign revocation (§5.5): the preview lists the accounts whose current grant came from the
 * campaign with a digest of that membership; the confirmation refuses a changed membership with
 * `admin.preview_stale`, then runs `restrict(userId, 'campaign_revoked')` for each account in bounded
 * batches of at most five, each with its audit event, and runs the post-commit effects per batch.
 */
export class CampaignRevocationService {
  constructor(private readonly options: CampaignRevocationServiceOptions) {}

  private async members(campaignId: string): Promise<{
    readonly exists: boolean;
    readonly labelRow: DbRow | null;
    readonly members: Member[];
  }> {
    const results = await this.options.db.batch([
      sql(
        `SELECT id, label_enc, label_owner_id FROM beta_invites WHERE campaign_id = :campaign
         ORDER BY label_enc IS NULL, created_at LIMIT 1`,
        { campaign: campaignId },
      ),
      sql(
        `SELECT g.id AS grant_id, g.granted_at, u.id AS user_id, u.email, u.display_name_enc
         FROM beta_access_grants g JOIN users u ON u.id = g.user_id
         WHERE g.campaign_id = :campaign AND g.revoked_at IS NULL AND u.deletion_state = 'none'
         ORDER BY g.granted_at, g.id LIMIT 10000`,
        { campaign: campaignId },
      ),
    ]);
    const labelRow = results[0]?.results[0] ?? null;
    return {
      exists: labelRow !== null,
      labelRow,
      members: (results[1]?.results ?? []).map((row) => ({
        userId: textColumn(row, "user_id"),
        email: textColumn(row, "email"),
        displayNameEnc: nullableTextColumn(row, "display_name_enc"),
        grantId: textColumn(row, "grant_id"),
        grantedAt: integerColumn(row, "granted_at"),
      })),
    };
  }

  async preview(campaignId: string): Promise<CampaignRevocationPreview> {
    const { exists, labelRow, members } = await this.members(campaignId);
    if (!exists || !labelRow) throw new AccessFeatureError("not_found");
    const labelOwner = nullableTextColumn(labelRow, "label_owner_id");
    const ring = await loadKeyRing(this.options.db, this.options.keys, [
      labelOwner,
      ...members.map((member) => member.userId),
    ]);
    try {
      return {
        campaignId,
        label: labelOwner
          ? decryptTextOrNull(
              ring.get(labelOwner),
              inviteLabelContext(labelOwner, textColumn(labelRow, "id")),
              labelRow.label_enc,
            )
          : null,
        accounts: members.map((member) => ({
          id: member.userId as CampaignRevocationPreview["accounts"][number]["id"],
          email: member.email,
          displayName: decryptTextOrNull(
            ring.get(member.userId),
            displayNameContext(member.userId),
            member.displayNameEnc,
          ),
          grantId: member.grantId,
          grantedAt: member.grantedAt,
        })),
        previewDigest: campaignPreviewDigest(campaignId, members),
      };
    } finally {
      ring.dispose();
    }
  }

  async confirm(input: {
    readonly adminId: string;
    readonly campaignId: string;
    readonly previewDigest: string;
    readonly reason: string;
    readonly requestId: string;
  }): Promise<CampaignRevocationResult> {
    const { db, keys } = this.options;
    const { exists, members } = await this.members(input.campaignId);
    if (!exists) throw new AccessFeatureError("not_found");
    if (campaignPreviewDigest(input.campaignId, members) !== input.previewDigest) {
      throw new AccessFeatureError("admin.preview_stale");
    }
    let revoked = 0;
    let unchanged = 0;
    for (let start = 0; start < members.length; start += MAX_RESTRICTIONS_PER_BATCH) {
      const chunk = members.slice(start, start + MAX_RESTRICTIONS_PER_BATCH);
      const ring = await loadKeyRing(
        db,
        keys,
        chunk.map((member) => member.userId),
      );
      const now = this.options.now();
      const statements: Statement[] = [];
      const verifyIndexes: number[] = [];
      try {
        for (const member of chunk) {
          const writeId = uuidv7(now);
          const eventId = uuidv7(now);
          const key = ring.get(member.userId);
          statements.push(
            ...this.options.access.restrictStatements({
              userId: member.userId,
              reason: "campaign_revoked",
              campaignId: input.campaignId,
              writeId,
              now,
            }),
            adminEventInsertStatement(
              {
                id: eventId,
                actorKind: "admin",
                actorId: input.adminId,
                action: "campaign_access_revoked",
                targetKind: "user",
                targetId: member.userId,
                reasonEnc: key
                  ? encryptText(key, adminReasonContext(member.userId, eventId), input.reason)
                  : null,
                reasonOwnerId: key ? member.userId : null,
                before: { betaState: "unlocked", grantId: member.grantId },
                after: { betaState: "relocked", campaignId: input.campaignId },
                requestId: `${input.requestId}:${member.userId}`,
                createdAt: now,
              },
              restrictGuard({ userId: member.userId, writeId }),
            ),
            sql(`SELECT access_generation FROM users WHERE id = :user AND write_id = :w`, {
              user: member.userId,
              w: writeId,
            }),
          );
          verifyIndexes.push(statements.length - 1);
        }
      } finally {
        ring.dispose();
      }
      const results = await db.batch(statements);
      for (const [index, member] of chunk.entries()) {
        const row = verifiedRow(results, verifyIndexes[index] ?? -1);
        if (!row) {
          unchanged += 1;
          continue;
        }
        revoked += 1;
        const accessGeneration = integerColumn(row, "access_generation");
        await this.options.access.afterRestriction({
          userId: member.userId,
          reason: "campaign_revoked",
          accessGeneration,
          committedAt: now,
        });
        await this.options.onRestricted?.(member.userId, accessGeneration);
      }
    }
    return { campaignId: input.campaignId, revoked, unchanged };
  }
}
