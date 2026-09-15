import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AccessLevel } from "@symplist/contracts";
import type { SessionContext } from "@symplist/core/access";
import type { Request } from "express";
import { ApiError } from "./errors/api-error.ts";
import { requestStateOf } from "./request-context.ts";

/** Metadata key of {@link Access}. */
export const ACCESS_METADATA = "symplist:access";

export interface AccessOptions {
  /**
   * Read the session and access fields fresh from D1 instead of the 10-second cache. Required for
   * the operations listed in §3.3 ({@link freshReadOperations}).
   */
  readonly fresh?: boolean;
}

export interface AccessRequirement {
  readonly level: AccessLevel;
  readonly fresh: boolean;
}

/**
 * The operations that always read D1 fresh (§3.3). Routes implementing them declare
 * `@Access(level, { fresh: true })`; background code calls `SessionService.loadFresh`.
 */
export const freshReadOperations = Object.freeze([
  "approval_decision",
  "vault_unlock",
  "vault_reset",
  "vault_grant_create",
  "share_release",
  "api_key_create",
  "oauth_grant_create",
  "oauth_consent_decision",
  "connection_completion",
  "admin_action",
  "account_deletion",
  "run_dispatch",
] as const);

export type FreshReadOperation = (typeof freshReadOperations)[number];

/**
 * Requires a session cookie and an access level (§5.4): `identity` (a live session, no deletion in
 * progress), `admitted` (verified, unlocked, not suspended or relocked) or `admin`. Only classes that
 * read the session cookie may declare it (§5.3).
 */
export const Access = (
  level: AccessLevel,
  options: AccessOptions = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata(ACCESS_METADATA, Object.freeze({ level, fresh: options.fresh === true }));

/** The authenticated session of an `@Access` route. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionContext => {
    const session = requestStateOf(context.switchToHttp().getRequest<Request>())?.session;
    if (!session) throw ApiError.internal();
    return session;
  },
);
