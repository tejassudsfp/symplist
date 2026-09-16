import type {
  AccountDeletionAuthorizationResponse,
  OtpChallengeResponse,
} from "@symplist/contracts";
import { int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { AccessFeatureError } from "../access/feature-error.ts";
import type { OtpService } from "../access/otp.ts";
import type { AccountDeletionResult, AccountDeletionService } from "./deletion.ts";

/** An `account_delete` authorization is valid for 10 minutes after the OTP verified (§5.1, §5.6). */
export const ACCOUNT_DELETE_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

export interface AccountDeletionRequestServiceOptions {
  readonly otp: Pick<OtpService, "sendForSession" | "verify">;
  readonly deletion: Pick<AccountDeletionService, "delete">;
  readonly now: () => number;
}

/** The session asking to delete its own account. */
export interface DeletionRequester {
  readonly userId: string;
  readonly sessionId: string;
}

/**
 * The account deletion request (§5.6): an `account_delete` OTP bound to the requesting auth session,
 * its verification issuing a single-use authorization bound to the same user and session, and the
 * deletion itself, which runs the platform's crypto-shred batch (`AccountDeletionService`) and its
 * post-commit effects (sockets, runs, PostHog, purge dispatch). Allowed at the `identity` level, so
 * locked, relocked and suspended accounts can leave.
 */
export class AccountDeletionRequestService {
  constructor(private readonly options: AccountDeletionRequestServiceOptions) {}

  sendCode(requester: DeletionRequester): Promise<OtpChallengeResponse> {
    return this.options.otp.sendForSession({ ...requester, purpose: "account_delete" });
  }

  /** Verifies the code and issues the authorization in the consuming batch. */
  async verifyCode(
    requester: DeletionRequester,
    input: { readonly challengeId: string; readonly code: string },
  ): Promise<AccountDeletionAuthorizationResponse> {
    const verified = await this.options.otp.verify({
      challengeId: input.challengeId,
      code: input.code,
      purposes: ["account_delete"],
      binding: requester,
      success: ({ guard, now, challengeId }) => {
        const authorizationId = uuidv7(now);
        const writeId = uuidv7(now);
        const expiresAt = now + ACCOUNT_DELETE_AUTHORIZATION_TTL_MS;
        return {
          statements: [
            sql(
              `INSERT INTO account_delete_authorizations
                 (id, user_id, auth_session_id, challenge_id, created_at, expires_at, consumed_at, write_id)
               SELECT :authorization, :user, :session, :challenge, :now, :expires, NULL, :w
               WHERE ${guard.exists}
                 AND EXISTS (SELECT 1 FROM auth_sessions WHERE id = :session AND user_id = :user
                   AND revoked_at IS NULL AND expires_at > CAST(:now AS INTEGER))`,
              {
                ...guard.params,
                authorization: authorizationId,
                user: requester.userId,
                session: requester.sessionId,
                challenge: challengeId,
                now: int(now),
                expires: int(expiresAt),
                w: writeId,
              },
            ),
            sql(
              `SELECT id, expires_at FROM account_delete_authorizations WHERE id = :authorization AND write_id = :w`,
              { authorization: authorizationId, w: writeId },
            ),
          ],
          decide: (results, offset) => {
            if (!verifiedRow(results, offset + 1)) throw new AccessFeatureError("otp.expired");
            return { authorizationId, expiresAt };
          },
        };
      },
    });
    return verified.value;
  }

  /** Runs the deletion batch; a missing, used, expired or foreign authorization is refused. */
  async requestDeletion(
    requester: DeletionRequester,
    authorizationId: string,
  ): Promise<Extract<AccountDeletionResult, { status: "deleted" }>> {
    const result = await this.options.deletion.delete({
      userId: requester.userId,
      authorizationId,
      authSessionId: requester.sessionId,
      now: this.options.now(),
    });
    if (result.status === "deleted") return result;
    if (result.status === "not_found") throw new AccessFeatureError("auth.session_required");
    throw new AccessFeatureError("account.deletion_unauthorized");
  }
}
