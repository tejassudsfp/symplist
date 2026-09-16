import {
  accessStateSchema,
  betaStateSchema,
  deletionStateSchema,
  onboardingStepSchema,
  restrictionReasonSchema,
  userRoleSchema,
} from "../common/access.ts";
import { emailAddressSchema } from "../common/email.ts";
import { oneTimeSecretResponseSchema } from "../common/idempotency.ts";
import { idSchema, inviteIdSchema, userIdSchema } from "../common/ids.ts";
import { cursorSchema, pageLimitSchema, pageSchema } from "../common/pagination.ts";
import { counterSchema, epochMillisSchema } from "../common/primitives.ts";
import { z } from "../common/zod.ts";
import { inviteCodeInputMaxLength } from "./invite-code.ts";

/**
 * REST request and response schemas owned by the access feature (§5): sign-in and signup with email
 * OTP, the signed-in identity, beta invite redemption, account deletion requests and beta
 * administration. Names carry an access-specific prefix so the contracts index stays collision free.
 */

export * from "./invite-code.ts";

/* ------------------------------------------------------------------------------------------------
 * Shared primitives
 * --------------------------------------------------------------------------------------------- */

/** OTP challenge purposes (§5.1). Each purpose has its own challenges, limits and email wording. */
export const otpPurposes = ["login", "signup", "vault_reset", "account_delete"] as const;
export const otpPurposeSchema = z.enum(otpPurposes);
export type OtpPurpose = z.infer<typeof otpPurposeSchema>;

/**
 * A submitted OTP code: 6 to 12 digits. Spaces and hyphens a person pastes between groups are
 * removed first; the error message never echoes the input.
 */
export const otpCodeSchema = z
  .string({ error: "Expected a code" })
  .max(64, { error: "Expected a code" })
  .transform((value) => value.replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^\d{6,12}$/, { error: "Expected a code of 6 to 12 digits" }));

/** The longest display name after normalization. */
export const displayNameMaxLength = 80;

/**
 * A display name (§4.4, encrypted at rest): Unicode NFC, surrounding whitespace trimmed and inner
 * whitespace runs collapsed to one space; control and format characters are refused.
 */
export const displayNameSchema = z
  .string({ error: "Expected a name" })
  .max(displayNameMaxLength * 4, { error: "Name is too long" })
  .transform((value) => value.normalize("NFC").replace(/\s+/gu, " ").trim())
  .pipe(
    z
      .string()
      .min(1, { error: "Enter a name" })
      .max(displayNameMaxLength, { error: "Name is too long" })
      .refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), {
        error: "Name contains characters that cannot be shown",
      }),
  );

/** An admin reason (encrypted under the target account's key, §5.6). */
export const adminReasonSchema = z
  .string({ error: "Expected a reason" })
  .max(2000, { error: "Reason is too long" })
  .transform((value) => value.normalize("NFC").trim())
  .pipe(
    z
      .string()
      .min(1, { error: "Enter a reason" })
      .max(500, { error: "Reason is too long" })
      .refine((value) => !/\p{Cc}/u.test(value.replace(/[\n\t]/g, "")), {
        error: "Reason contains characters that cannot be shown",
      }),
  );

/** A private invite label or campaign note (encrypted under the creating admin's key, §4.4). */
export const inviteLabelSchema = z
  .string({ error: "Expected a label" })
  .max(400, { error: "Label is too long" })
  .transform((value) => value.normalize("NFC").replace(/\s+/gu, " ").trim())
  .pipe(
    z
      .string()
      .min(1, { error: "Enter a label" })
      .max(100, { error: "Label is too long" })
      .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value), {
        error: "Label contains characters that cannot be shown",
      }),
  );

/** Epoch milliseconds in a query string: canonical decimal text, converted to a number. */
export const epochMillisQuerySchema = z
  .string({ error: "Expected a timestamp" })
  .regex(/^(0|[1-9][0-9]{0,15})$/, { error: "Expected a timestamp" })
  .transform(Number)
  .pipe(epochMillisSchema);

/* ------------------------------------------------------------------------------------------------
 * Sign-in, signup and OTP (§5.1; pre_session route class)
 * --------------------------------------------------------------------------------------------- */

/** `POST /v1/auth/lookup`. */
export const authLookupRequestSchema = z.strictObject({ email: emailAddressSchema });
export type AuthLookupRequest = z.infer<typeof authLookupRequestSchema>;

/**
 * Whether a verified account uses the address (intentional, throttled). A pending registration that
 * never verified reports `false`, so the person confirms signup again and nothing is duplicated.
 */
export const authLookupResponseSchema = z.strictObject({ exists: z.boolean() });
export type AuthLookupResponse = z.infer<typeof authLookupResponseSchema>;

/** `POST /v1/auth/signup`: only an explicit confirmation creates the pending account. */
export const authSignupRequestSchema = z.strictObject({
  email: emailAddressSchema,
  consent: z.literal(true, { error: "Signup needs explicit confirmation" }),
});
export type AuthSignupRequest = z.infer<typeof authSignupRequestSchema>;

/** `POST /v1/auth/otp`: a login code for an existing verified account. */
export const otpSendRequestSchema = z.strictObject({ email: emailAddressSchema });
export type OtpSendRequest = z.infer<typeof otpSendRequestSchema>;

/**
 * The response of every OTP send. The verify request must carry `challengeId` (§5.3). Delivery was
 * submitted to the email provider before this response is sent.
 */
export const otpChallengeResponseSchema = z.strictObject({
  challengeId: idSchema,
  purpose: otpPurposeSchema,
  expiresAt: epochMillisSchema,
  /** No new code for this purpose is sent before this instant (60-second cooldown). */
  resendAvailableAt: epochMillisSchema,
  codeLength: z.number().int().min(6).max(12),
});
export type OtpChallengeResponse = z.infer<typeof otpChallengeResponseSchema>;

/** `POST /v1/auth/otp/verify` and the account deletion verify. */
export const otpVerifyRequestSchema = z.strictObject({
  challengeId: idSchema,
  code: otpCodeSchema,
});
export type OtpVerifyRequest = z.infer<typeof otpVerifyRequestSchema>;

/* ------------------------------------------------------------------------------------------------
 * The signed-in identity (§5.4)
 * --------------------------------------------------------------------------------------------- */

/**
 * Where the web app sends the person (§5.4, beta gate and access revoked briefs): admitted accounts
 * go to the app or resume onboarding, verified locked accounts to the beta gate, and relocked or
 * suspended accounts to the paused-access screen, which has no redeem form.
 */
export const accessDestinations = ["app", "onboarding", "beta_gate", "paused"] as const;
export const accessDestinationSchema = z.enum(accessDestinations);
export type AccessDestination = z.infer<typeof accessDestinationSchema>;

export const meUserSchema = z.strictObject({
  id: userIdSchema,
  email: z.string().min(3).max(320),
  /** Null until the person saves a name during onboarding. */
  displayName: z.string().max(displayNameMaxLength).nullable(),
  role: userRoleSchema,
});
export type MeUser = z.infer<typeof meUserSchema>;

/** `GET /v1/me`, and the body of every call that changes the caller's own access or profile. */
export const meResponseSchema = z.strictObject({
  user: meUserSchema,
  access: accessStateSchema,
  destination: accessDestinationSchema,
  /** `BETA_ACCESS_REQUIRED`; self-hosted deployments without the gate skip the beta gate screen. */
  betaAccessRequired: z.boolean(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** `PUT /v1/me/name` (onboarding and Settings → Account). */
export const updateDisplayNameRequestSchema = z.strictObject({ displayName: displayNameSchema });
export type UpdateDisplayNameRequest = z.infer<typeof updateDisplayNameRequestSchema>;

/** `POST /v1/auth/logout`. */
export const logoutResponseSchema = z.strictObject({ signedOut: z.literal(true) });
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Invite redemption (§5.4)
 * --------------------------------------------------------------------------------------------- */

/**
 * `POST /v1/access/redeem`. The code is any pasted text up to 128 characters; malformed, unknown,
 * expired, exhausted, revoked and email-bound codes all answer the same `invite.invalid`.
 */
export const redeemInviteRequestSchema = z.strictObject({
  code: z
    .string({ error: "Enter an invite code" })
    .min(1, { error: "Enter an invite code" })
    .max(inviteCodeInputMaxLength, { error: "Enter an invite code" }),
});
export type RedeemInviteRequest = z.infer<typeof redeemInviteRequestSchema>;

export const redeemInviteResponseSchema = z.strictObject({
  /** `already_unlocked`: the account was admitted before, and no seat was consumed. */
  outcome: z.enum(["unlocked", "already_unlocked"]),
  me: meResponseSchema,
});
export type RedeemInviteResponse = z.infer<typeof redeemInviteResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Account deletion request (§5.6)
 * --------------------------------------------------------------------------------------------- */

/** `POST /v1/account/deletion/verify`: a single-use authorization, valid for 10 minutes. */
export const accountDeletionAuthorizationResponseSchema = z.strictObject({
  authorizationId: idSchema,
  expiresAt: epochMillisSchema,
});
export type AccountDeletionAuthorizationResponse = z.infer<
  typeof accountDeletionAuthorizationResponseSchema
>;

/** `POST /v1/account/deletion`. */
export const accountDeletionRequestSchema = z.strictObject({ authorizationId: idSchema });
export type AccountDeletionRequest = z.infer<typeof accountDeletionRequestSchema>;

/**
 * The deletion was accepted: the account key is already shredded and every session ended; the purge
 * of stored data continues in the background.
 */
export const accountDeletionResponseSchema = z.strictObject({ status: z.literal("deleting") });
export type AccountDeletionResponse = z.infer<typeof accountDeletionResponseSchema>;

/* ------------------------------------------------------------------------------------------------
 * Administration: invites
 * --------------------------------------------------------------------------------------------- */

/** Derived at read time; `redemption_count` is never stored (§5.4). */
export const inviteStatuses = ["active", "exhausted", "expired", "revoked"] as const;
export const inviteStatusSchema = z.enum(inviteStatuses);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

/** Independent codes (one per person, optionally in a batch) or one shared campaign code. */
export const inviteModes = ["independent", "shared"] as const;
export const inviteModeSchema = z.enum(inviteModes);
export type InviteMode = z.infer<typeof inviteModeSchema>;

/** The largest batch of independent codes one request generates. */
export const inviteBatchMax = 100;
/** The largest redemption cap of one code. */
export const inviteMaxRedemptionsLimit = 10_000;
/** The furthest expiry from now, in days. */
export const inviteMaxExpiryDays = 365;

export const adminInviteSchema = z.strictObject({
  id: inviteIdSchema,
  /** Every code generated by one request shares a campaign id (§5.5 campaign revocation). */
  campaignId: idSchema,
  mode: inviteModeSchema,
  /** The private label or note; null when none was given or its owner's key is gone. */
  label: z.string().max(100).nullable(),
  /** The last four characters of the code; the full code is never recoverable. */
  hint: z.string().regex(/^[A-Z2-7]{4}$/),
  status: inviteStatusSchema,
  used: counterSchema,
  maxRedemptions: counterSchema,
  remaining: counterSchema,
  boundEmail: z.string().max(320).nullable(),
  expiresAt: epochMillisSchema,
  createdAt: epochMillisSchema,
  createdBy: idSchema,
  revokedAt: epochMillisSchema.nullable(),
  /** Pass back as `expectedVersion` so a concurrent edit is refused instead of overwritten. */
  version: counterSchema,
});
export type AdminInvite = z.infer<typeof adminInviteSchema>;

/**
 * `POST /v1/admin/invites`. Independent mode generates `count` codes, each with its own cap; shared
 * mode generates exactly one campaign code. A bound email restricts who can redeem and sends nothing;
 * it applies to a single code only.
 */
export const generateInvitesRequestSchema = z
  .strictObject({
    mode: inviteModeSchema,
    count: z.number().int().min(1).max(inviteBatchMax),
    maxRedemptions: z.number().int().min(1).max(inviteMaxRedemptionsLimit),
    expiresAt: epochMillisSchema,
    label: inviteLabelSchema.optional(),
    boundEmail: emailAddressSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.mode === "shared" && value.count !== 1) {
      context.addIssue({
        code: "custom",
        path: ["count"],
        message: "A shared campaign code is a single code",
      });
    }
    if (value.boundEmail !== undefined && value.count !== 1) {
      context.addIssue({
        code: "custom",
        path: ["boundEmail"],
        message: "An email binding applies to a single code",
      });
    }
  });
export type GenerateInvitesRequest = z.infer<typeof generateInvitesRequestSchema>;

/** `SYM-XXXX-…`: shown once in the minting response and never stored, logged or replayed (§6.1). */
export const generatedInviteCodeSchema = z.string().regex(/^SYM(-[A-Z2-7]{4}){8}$/);

/**
 * The minting response carries `codes`, one per invite in the order of `invites` (the secret field
 * holds nothing else, so no identifier is ever redacted with it); an exact retry replays only the
 * non-secret outcome with `secretUnavailable: true` and `notice: "secret.already_issued"` (decision
 * R11).
 */
export const generateInvitesResponseSchema = oneTimeSecretResponseSchema(
  {
    campaignId: idSchema,
    invites: z.array(adminInviteSchema).min(1).max(inviteBatchMax),
  },
  { codes: z.array(generatedInviteCodeSchema).min(1).max(inviteBatchMax) },
);
export type GenerateInvitesResponse = z.infer<typeof generateInvitesResponseSchema>;

/** `GET /v1/admin/invites`. `q` matches the hint, bound email or label; `campaignId` narrows. */
export const listInvitesQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: pageLimitSchema.optional(),
  status: inviteStatusSchema.optional(),
  campaignId: idSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export type ListInvitesQuery = z.infer<typeof listInvitesQuerySchema>;

export const adminInvitePageSchema = pageSchema(adminInviteSchema);
export type AdminInvitePage = z.infer<typeof adminInvitePageSchema>;

/** One claimed seat of an invite: verified account identity and date, never private content. */
export const adminRedemptionSchema = z.strictObject({
  id: idSchema,
  seatNo: z.number().int().min(1),
  userId: idSchema,
  /** Null when the account was deleted. */
  email: z.string().max(320).nullable(),
  displayName: z.string().max(displayNameMaxLength).nullable(),
  accessEpoch: counterSchema,
  redeemedAt: epochMillisSchema,
  /** `current` while the grant from this seat admits the account; `none` when it never finalized. */
  grant: z.enum(["current", "revoked", "none"]),
});
export type AdminRedemption = z.infer<typeof adminRedemptionSchema>;

/** `GET /v1/admin/invites/:id`. */
export const adminInviteDetailSchema = z.strictObject({
  invite: adminInviteSchema,
  redemptions: z.array(adminRedemptionSchema).max(500),
});
export type AdminInviteDetail = z.infer<typeof adminInviteDetailSchema>;

/** `POST /v1/admin/invites/:id/capacity`: never below the seats already used. */
export const updateInviteCapacityRequestSchema = z.strictObject({
  maxRedemptions: z.number().int().min(1).max(inviteMaxRedemptionsLimit),
  expectedVersion: counterSchema,
});
export type UpdateInviteCapacityRequest = z.infer<typeof updateInviteCapacityRequestSchema>;

/** `POST /v1/admin/invites/:id/expiry`: a later expiry than the current one. */
export const extendInviteExpiryRequestSchema = z.strictObject({
  expiresAt: epochMillisSchema,
  expectedVersion: counterSchema,
});
export type ExtendInviteExpiryRequest = z.infer<typeof extendInviteExpiryRequestSchema>;

/** `POST /v1/admin/invites/:id/revoke`: stops future redemption; admitted accounts keep access. */
export const revokeInviteRequestSchema = z.strictObject({ expectedVersion: counterSchema });
export type RevokeInviteRequest = z.infer<typeof revokeInviteRequestSchema>;

/* ------------------------------------------------------------------------------------------------
 * Administration: accounts
 * --------------------------------------------------------------------------------------------- */

/**
 * Account list filters: `pending` (registered, never verified), `locked` (verified, not admitted),
 * `unlocked` and `paused` (relocked or suspended).
 */
export const adminAccountFilters = ["pending", "locked", "unlocked", "paused"] as const;
export const adminAccountFilterSchema = z.enum(adminAccountFilters);
export type AdminAccountFilter = z.infer<typeof adminAccountFilterSchema>;

export const grantSources = ["invite", "admin"] as const;
export const grantSourceSchema = z.enum(grantSources);
export type GrantSource = z.infer<typeof grantSourceSchema>;

export const adminAccountSchema = z.strictObject({
  id: userIdSchema,
  email: z.string().max(320),
  displayName: z.string().max(displayNameMaxLength).nullable(),
  emailVerifiedAt: epochMillisSchema.nullable(),
  betaState: betaStateSchema,
  suspendedAt: epochMillisSchema.nullable(),
  onboardingStep: onboardingStepSchema,
  role: userRoleSchema,
  deletionState: deletionStateSchema,
  /** The source of the current access grant, if any. */
  grantSource: grantSourceSchema.nullable(),
  createdAt: epochMillisSchema,
  /** Pass back as `expectedGeneration`; every restriction and restore moves it. */
  accessGeneration: counterSchema,
  accessEpoch: counterSchema,
});
export type AdminAccount = z.infer<typeof adminAccountSchema>;

/** `GET /v1/admin/accounts`. `q` matches part of the email address. */
export const listAccountsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: pageLimitSchema.optional(),
  filter: adminAccountFilterSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

export const adminAccountPageSchema = pageSchema(adminAccountSchema);
export type AdminAccountPage = z.infer<typeof adminAccountPageSchema>;

/** One access grant in an account's admission history. */
export const adminGrantSchema = z.strictObject({
  id: idSchema,
  source: grantSourceSchema,
  /** The invite behind an invite grant (inspect the invite reference). */
  inviteId: inviteIdSchema.nullable(),
  inviteHint: z
    .string()
    .regex(/^[A-Z2-7]{4}$/)
    .nullable(),
  campaignId: idSchema.nullable(),
  grantedAt: epochMillisSchema,
  actorId: idSchema.nullable(),
  /** The admin reason, decrypted with the account's key; null when none was recorded. */
  reason: z.string().max(500).nullable(),
  revokedAt: epochMillisSchema.nullable(),
  revokedReason: restrictionReasonSchema.nullable(),
});
export type AdminGrant = z.infer<typeof adminGrantSchema>;

export const adminAccountRedemptionSchema = z.strictObject({
  id: idSchema,
  inviteId: inviteIdSchema,
  inviteHint: z.string().regex(/^[A-Z2-7]{4}$/),
  campaignId: idSchema,
  seatNo: z.number().int().min(1),
  accessEpoch: counterSchema,
  redeemedAt: epochMillisSchema,
});
export type AdminAccountRedemption = z.infer<typeof adminAccountRedemptionSchema>;

/* ------------------------------------------------------------------------------------------------
 * Administration: activity
 * --------------------------------------------------------------------------------------------- */

/** Every audit action the access feature records (plus the platform's `admin_bootstrap`). */
export const adminEventActions = [
  "invite_generated",
  "invite_redeemed",
  "invite_capacity_changed",
  "invite_expiry_extended",
  "invite_revoked",
  "account_unlocked",
  "access_relocked",
  "eligibility_restored",
  "access_restored",
  "campaign_access_revoked",
  "admin_bootstrap",
  "admin_rebootstrap",
] as const;
export const adminEventActionSchema = z.enum(adminEventActions);
export type AdminEventAction = z.infer<typeof adminEventActionSchema>;

export const adminEventSchema = z.strictObject({
  id: idSchema,
  createdAt: epochMillisSchema,
  actor: z.strictObject({
    kind: z.enum(["user", "admin", "system"]),
    id: idSchema.nullable(),
    /** Null for the system and for deleted accounts ("Deleted account"). */
    email: z.string().max(320).nullable(),
  }),
  action: adminEventActionSchema,
  target: z.strictObject({
    kind: z.enum(["user", "invite", "campaign", "system"]),
    id: idSchema.nullable(),
    /** The account email, or the invite hint; null for deleted accounts. */
    label: z.string().max(320).nullable(),
  }),
  /** Plaintext operational values such as a beta state or a cap; never secrets or content. */
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  hasReason: z.boolean(),
  /** The campaign the event concerns, with its label ("Maya redeemed Friends — September"). */
  campaign: z
    .strictObject({
      id: idSchema,
      label: z.string().max(100).nullable(),
    })
    .nullable(),
});
export type AdminEvent = z.infer<typeof adminEventSchema>;

/** `GET /v1/admin/activity/:id`: the reason, decrypted with the target account's key. */
export const adminEventDetailSchema = z.strictObject({
  event: adminEventSchema,
  reason: z.string().max(500).nullable(),
  /** The reason exists but can no longer be read, because its account was deleted. */
  reasonUnavailable: z.boolean(),
});
export type AdminEventDetail = z.infer<typeof adminEventDetailSchema>;

/** `GET /v1/admin/activity`. `accountId` matches the actor or the target. */
export const listActivityQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: pageLimitSchema.optional(),
  action: adminEventActionSchema.optional(),
  actorId: idSchema.optional(),
  accountId: idSchema.optional(),
  inviteId: inviteIdSchema.optional(),
  campaignId: idSchema.optional(),
  from: epochMillisQuerySchema.optional(),
  to: epochMillisQuerySchema.optional(),
});
export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;

export const adminEventPageSchema = pageSchema(adminEventSchema);
export type AdminEventPage = z.infer<typeof adminEventPageSchema>;

/** `GET /v1/admin/accounts/:id`: identity, admission history and the access audit trail. */
export const adminAccountDetailSchema = z.strictObject({
  account: adminAccountSchema,
  grants: z.array(adminGrantSchema).max(200),
  redemptions: z.array(adminAccountRedemptionSchema).max(200),
  events: z.array(adminEventSchema).max(100),
});
export type AdminAccountDetail = z.infer<typeof adminAccountDetailSchema>;

/**
 * Unlock, relock, restore eligibility and restore access. The reason is required and audited;
 * `expectedGeneration` refuses an action on an account whose access changed since it was read.
 */
export const adminAccountActionRequestSchema = z.strictObject({
  reason: adminReasonSchema,
  expectedGeneration: counterSchema,
});
export type AdminAccountActionRequest = z.infer<typeof adminAccountActionRequestSchema>;

/* ------------------------------------------------------------------------------------------------
 * Administration: campaign revocation (§5.5)
 * --------------------------------------------------------------------------------------------- */

export const campaignRevocationAccountSchema = z.strictObject({
  id: userIdSchema,
  email: z.string().max(320),
  displayName: z.string().max(displayNameMaxLength).nullable(),
  grantId: idSchema,
  grantedAt: epochMillisSchema,
});

/** `POST /v1/admin/campaigns/:id/revocation/preview`. */
export const campaignRevocationPreviewSchema = z.strictObject({
  campaignId: idSchema,
  label: z.string().max(100).nullable(),
  accounts: z.array(campaignRevocationAccountSchema).max(10_000),
  /** Echo in the confirmation; a changed membership answers `admin.preview_stale`. */
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CampaignRevocationPreview = z.infer<typeof campaignRevocationPreviewSchema>;

/** `POST /v1/admin/campaigns/:id/revocation/confirm`. */
export const campaignRevocationConfirmRequestSchema = z.strictObject({
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/, { error: "Expected a preview digest" }),
  reason: adminReasonSchema,
});
export type CampaignRevocationConfirmRequest = z.infer<
  typeof campaignRevocationConfirmRequestSchema
>;

export const campaignRevocationResultSchema = z.strictObject({
  campaignId: idSchema,
  /** Accounts whose access this confirmation took away. */
  revoked: counterSchema,
  /** Accounts already relocked or deleted by the time their batch ran. */
  unchanged: counterSchema,
});
export type CampaignRevocationResult = z.infer<typeof campaignRevocationResultSchema>;
