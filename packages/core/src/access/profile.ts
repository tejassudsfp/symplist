import type { AccessDestination, MeResponse, UserRole } from "@symplist/contracts";
import type { KeyProvider } from "@symplist/crypto";
import { zeroize } from "@symplist/crypto";
import type { DbClient, DbRow, RequestPriority, Statement, StatementResult } from "@symplist/db";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { AccountKeyStore } from "../account/keys.ts";
import { type AccessPolicy, evaluateAccess } from "./evaluate.ts";
import { AccessFeatureError } from "./feature-error.ts";
import { decryptTextOrNull, displayNameContext, encryptText } from "./fields.ts";
import type { FinalizedRedemption, RedemptionService } from "./redemption.ts";
import { enumColumn, integerColumn, textColumn } from "./rows.ts";
import type { StatementGuard } from "./sessions.ts";
import { ACCESS_STATE_COLUMNS, accessCondition, accessStateFromRow } from "./sql.ts";
import type { AccessState } from "./types.ts";

/** Where the web app sends an account with this access state (§5.4). */
export function accessDestination(access: AccessState, policy: AccessPolicy): AccessDestination {
  const decision = evaluateAccess(access, "admitted", policy);
  if (decision.allowed) return access.onboardingStep === "done" ? "app" : "onboarding";
  if (decision.code === "access.relocked" || decision.code === "access.suspended") {
    return "paused";
  }
  return "beta_gate";
}

export interface ProfileServiceOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly policy: AccessPolicy;
  readonly now: () => number;
  readonly redemptions: Pick<RedemptionService, "finalize" | "pendingForUserStatement">;
}

/** The statements that read one account's profile, in the order {@link ProfileService.fromResults} expects. */
export interface ProfileRead {
  readonly statements: readonly Statement[];
}

/**
 * The signed-in identity (§5.1, §5.4): `GET /v1/me` (email, decrypted display name, access state and
 * the destination the web app routes to), the encrypted display name, and the onboarding steps.
 */
export class ProfileService {
  private readonly accountKeys: AccountKeyStore;

  constructor(private readonly options: ProfileServiceOptions) {
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
  }

  /** Reads of the profile to fold into a batch: the users row and the account key row. */
  readStatements(userId: string): readonly Statement[] {
    return [
      sql(
        `SELECT id, email, display_name_enc, ${ACCESS_STATE_COLUMNS.join(", ")} FROM users WHERE id = :user`,
        { user: userId },
      ),
      this.accountKeys.selectStatement(userId),
    ];
  }

  /** Builds the response from {@link readStatements}' results starting at `offset`; null when missing. */
  fromResults(results: readonly StatementResult[], offset: number): MeResponse | null {
    const row = results[offset]?.results[0];
    if (!row) return null;
    const keyRow = results[offset + 1]?.results[0];
    return this.fromRows(row, keyRow);
  }

  private fromRows(row: DbRow, keyRow: DbRow | undefined): MeResponse {
    const userId = textColumn(row, "id");
    const access = accessStateFromRow(row);
    let displayName: string | null = null;
    if (keyRow && typeof row.display_name_enc === "string") {
      let key: ReturnType<AccountKeyStore["unwrapRow"]> | undefined;
      try {
        key = this.accountKeys.unwrapRow(keyRow);
        displayName = decryptTextOrNull(key, displayNameContext(userId), row.display_name_enc);
      } catch {
        displayName = null;
      } finally {
        if (key) zeroize(key.key);
      }
    }
    return {
      user: {
        id: userId as MeResponse["user"]["id"],
        email: textColumn(row, "email"),
        displayName,
        role: enumColumn<UserRole>(row, "role", ["member", "admin"]),
      },
      access,
      destination: accessDestination(access, this.options.policy),
      betaAccessRequired: this.options.policy.betaAccessRequired,
    };
  }

  /**
   * `GET /v1/me` in one batch. A seat claimed by the account whose follow-up never committed is
   * finalized first (the redemption reconciler, §5.4), so the person is never left behind the gate.
   */
  async me(
    userId: string,
  ): Promise<{ readonly me: MeResponse; readonly finalized: FinalizedRedemption | null }> {
    const { db } = this.options;
    const results = await db.batch([
      ...this.readStatements(userId),
      this.options.redemptions.pendingForUserStatement(userId),
    ]);
    const pending = results[2]?.results[0];
    let finalized: FinalizedRedemption | null = null;
    let me = this.fromResults(results, 0);
    if (pending && this.options.policy.betaAccessRequired) {
      finalized = await this.options.redemptions.finalize({
        id: textColumn(pending, "id"),
        userId,
        accessEpoch: integerColumn(pending, "access_epoch"),
      });
      me = this.fromResults(await db.batch(this.readStatements(userId)), 0);
    }
    if (me?.access.deletionState !== "none") {
      throw new AccessFeatureError("auth.session_required");
    }
    return { me, finalized };
  }

  /**
   * `PUT /v1/me/name`: stores the encrypted name and moves onboarding from `name` to `connections`.
   * Applies only while the account is admitted (§5.4), in the same statement.
   */
  async updateDisplayName(input: {
    readonly userId: string;
    readonly displayName: string;
  }): Promise<MeResponse> {
    const { db, policy } = this.options;
    const now = this.options.now();
    const key = await this.accountKeys.require(input.userId);
    let envelope: string;
    try {
      envelope = encryptText(key, displayNameContext(input.userId), input.displayName);
    } finally {
      zeroize(key.key);
    }
    const writeId = uuidv7(now);
    const results = await db.batch([
      sql(
        `UPDATE users SET display_name_enc = :name,
           onboarding_step = CASE WHEN onboarding_step = 'name' THEN 'connections' ELSE onboarding_step END,
           updated_at = :now, write_id = :w
         WHERE id = :access_user AND ${accessCondition({ level: "admitted", policy })}`,
        { name: envelope, now: int(now), w: writeId, access_user: input.userId },
      ),
      sql(`SELECT id FROM users WHERE id = :user AND write_id = :w`, {
        user: input.userId,
        w: writeId,
      }),
      ...this.readStatements(input.userId),
    ]);
    const me = this.fromResults(results, 2);
    if (!me) throw new AccessFeatureError("auth.session_required");
    if (!verifiedRow(results, 1)) this.throwNotAdmitted(me.access);
    return me;
  }

  /**
   * Finishes onboarding after the optional connections step (Continue or Skip for now). Returns the
   * current profile when onboarding is already done; refuses while the name step is unfinished.
   */
  async completeOnboarding(userId: string): Promise<MeResponse> {
    const { db, policy } = this.options;
    const now = this.options.now();
    const writeId = uuidv7(now);
    const results = await db.batch([
      sql(
        `UPDATE users SET onboarding_step = 'done', updated_at = :now, write_id = :w
         WHERE id = :access_user AND onboarding_step = 'connections'
           AND ${accessCondition({ level: "admitted", policy })}`,
        { now: int(now), w: writeId, access_user: userId },
      ),
      ...this.readStatements(userId),
    ]);
    const me = this.fromResults(results, 1);
    if (!me) throw new AccessFeatureError("auth.session_required");
    if (!evaluateAccess(me.access, "admitted", policy).allowed) this.throwNotAdmitted(me.access);
    if (me.access.onboardingStep === "name")
      throw new AccessFeatureError("onboarding.name_required");
    return me;
  }

  private throwNotAdmitted(access: AccessState): never {
    const decision = evaluateAccess(access, "admitted", this.options.policy);
    throw new AccessFeatureError(decision.allowed ? "admin.state_changed" : decision.code);
  }

  /**
   * What a successful sign-in or signup verification folds into the consuming batch (§5.1): the email
   * becomes verified (signup), the account key is provisioned when missing, the session is created
   * under the challenge guard, and the profile is read for the response.
   */
  loginStatements(input: {
    readonly userId: string;
    readonly purpose: "login" | "signup";
    readonly guard: StatementGuard;
    readonly now: number;
    readonly session: { readonly insert: Statement; readonly verify: Statement };
    readonly priority?: RequestPriority;
  }): { readonly statements: readonly Statement[]; readonly sessionVerifyIndex: number } {
    const statements: Statement[] = [];
    if (input.purpose === "signup") {
      statements.push(
        sql(
          `UPDATE users SET email_verified_at = COALESCE(email_verified_at, :now), updated_at = :now,
             write_id = :w
           WHERE id = :user AND deletion_state = 'none' AND ${input.guard.exists}`,
          { ...input.guard.params, now: int(input.now), w: uuidv7(input.now), user: input.userId },
        ),
      );
    }
    statements.push(this.accountKeys.provisionStatement({ userId: input.userId, now: input.now }));
    statements.push(input.session.insert);
    const sessionVerifyIndex = statements.length;
    statements.push(input.session.verify, ...this.readStatements(input.userId));
    return { statements, sessionVerifyIndex };
  }
}
