import type { KeyProvider, RandomOptions } from "@symplist/crypto";
import {
  computeDigest,
  computeDigestCandidates,
  constantTimeEqual,
  decodeBase64Url,
  generateToken,
  TOKEN_BYTES,
  verifyDigest,
} from "@symplist/crypto";
import type { DbClient, DbRow, Statement, StatementResult } from "@symplist/db";
import { analyzeStatement, int, sql, uuidv7, verifiedRow } from "@symplist/db";
import { sessionRevokeContributors as defaultRevokeContributors } from "./session-revoke-contributors/index.ts";
import type {
  SessionRevokeContributor,
  SessionRevokeInput,
} from "./session-revoke-contributors/types.ts";
import { accessStateFromRow, accessStateSelectList } from "./sql.ts";
import type { AccessState } from "./types.ts";

/** Session tokens are 32 random bytes, 43 base64url characters (§5.1). */
export const SESSION_TOKEN_BYTES = TOKEN_BYTES;

/** Absolute session lifetime: 30 days from sign-in, never extended by activity. */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** `last_seen_at` is written at most once per this interval per session (§5.1). */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** One row of `auth_sessions` that is live at the time it was read. */
export interface AuthSession {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

/** A live session with its user's access fields, read in one statement. */
export interface ResolvedSession {
  readonly session: AuthSession;
  readonly access: AccessState;
}

/** The outcome of looking a token up: a live session, a session that ended, or no session at all. */
export type SessionLookup =
  | { readonly status: "live"; readonly resolved: ResolvedSession }
  | { readonly status: "ended" }
  | { readonly status: "unknown" };

const UNKNOWN_SESSION: SessionLookup = Object.freeze({ status: "unknown" });
const ENDED_SESSION: SessionLookup = Object.freeze({ status: "ended" });

/** A created session; the raw token exists only here and in the `Set-Cookie` response header. */
export interface CreatedSession {
  readonly sessionId: string;
  /** The raw token for the cookie. Never logged or stored; D1 holds only its digest. */
  readonly token: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A session that is about to be created, with the statements that create it. */
export interface PreparedSession extends CreatedSession {
  /** The insert, to fold into the batch that authenticates the user (for example OTP verify). */
  readonly insert: Statement;
  /** Verification `SELECT` that returns the row only when the insert committed. */
  readonly verify: Statement;
}

/** An extra `EXISTS (…)` condition and its named parameters, appended to a guarded statement. */
export interface StatementGuard {
  readonly exists: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface SessionStoreOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  /** Defaults to every registered domain contribution (§2.3). */
  readonly revokeContributors?: readonly SessionRevokeContributor[];
  /** Random source for tokens; tests inject a deterministic one. */
  readonly random?: RandomOptions;
}

/** Whether a cookie value has the shape of a session token, so malformed values never reach D1. */
export function isWellFormedSessionToken(value: unknown): value is string {
  return typeof value === "string" && decodeBase64Url(value, SESSION_TOKEN_BYTES) !== undefined;
}

/**
 * The session-bound CSRF token for the `app` route class (§5.3):
 * `HMAC(SESSION_DIGEST_SECRET_<current>, 'csrf' || 0x00 || sessionId)` as base64url.
 */
export function csrfTokenForSession(keys: KeyProvider, sessionId: string): string {
  return computeDigest(keys, "SESSION_DIGEST_SECRET", "csrf", sessionId).digest;
}

/**
 * Checks a presented CSRF token against the session under every configured
 * `SESSION_DIGEST_SECRET` version with constant-time comparison, so a token issued before a rotation
 * keeps working while its version stays configured.
 */
export function verifyCsrfToken(keys: KeyProvider, sessionId: string, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const bytes = decodeBase64Url(presented, 32);
  if (!bytes) return false;
  let matched = false;
  for (const candidate of computeDigestCandidates(
    keys,
    "SESSION_DIGEST_SECRET",
    "csrf",
    sessionId,
  )) {
    const expected = decodeBase64Url(candidate.digest, 32);
    if (expected && constantTimeEqual(bytes, expected)) matched = true;
  }
  return matched;
}

function integer(row: DbRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Unexpected value in auth_sessions.${column}`);
  }
  return value;
}

function text(row: DbRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw new Error(`Unexpected value in auth_sessions.${column}`);
  return value;
}

function checkRevokeStatement(
  domain: string,
  statement: Statement,
  guard: StatementGuard | null,
): void {
  const targets = analyzeStatement(statement.sql).writeTargets;
  if (
    targets.length === 0 ||
    targets.some((target) => ["users", "auth_sessions"].includes(target.name))
  ) {
    throw new Error(`Session revoke contributor ${domain} must write only its own tables`);
  }
  if (guard) {
    const compiled = sql(guard.exists, guard.params);
    if (
      !statement.sql.includes(compiled.sql) ||
      compiled.params.some((value) => !statement.params.includes(value))
    ) {
      throw new Error(`Session revoke contributor ${domain} must carry the batch's guard`);
    }
  }
}

/**
 * Login sessions over `auth_sessions` (§5.1): creation with a digest-stored token, resolution with
 * the user's access fields in one read, bounded last-seen writes, and revocation of one or all
 * sessions together with every domain's session-bound state.
 */
export class SessionStore {
  private readonly db: DbClient;
  private readonly keys: KeyProvider;
  private readonly revokeContributors: readonly SessionRevokeContributor[];
  private readonly random: RandomOptions | undefined;

  constructor(options: SessionStoreOptions) {
    this.db = options.db;
    this.keys = options.keys;
    this.revokeContributors = options.revokeContributors ?? defaultRevokeContributors;
    this.random = options.random;
  }

  /**
   * Builds a new session for a user who is not being deleted. The insert only takes effect while the
   * user exists with `deletion_state = 'none'` and every extra guard holds.
   */
  prepareCreate(input: {
    readonly userId: string;
    readonly now: number;
    readonly guard?: StatementGuard;
  }): PreparedSession {
    const token = generateToken(SESSION_TOKEN_BYTES, this.random);
    const digest = computeDigest(this.keys, "SESSION_DIGEST_SECRET", "session", token);
    const sessionId = uuidv7(input.now);
    const writeId = uuidv7(input.now);
    const expiresAt = input.now + SESSION_LIFETIME_MS;
    const extra = input.guard ? ` AND ${input.guard.exists}` : "";
    const insert = sql(
      `INSERT INTO auth_sessions
         (id, user_id, token_digest, digest_version, created_at, last_seen_at, expires_at, revoked_at, write_id)
       SELECT :session, :user, :digest, :version, :now, :now, :expires, NULL, :w
       WHERE EXISTS (SELECT 1 FROM users WHERE id = :user AND deletion_state = 'none')${extra}`,
      {
        ...input.guard?.params,
        session: sessionId,
        user: input.userId,
        digest: digest.digest,
        version: int(digest.version),
        now: int(input.now),
        expires: int(expiresAt),
        w: writeId,
      },
    );
    const verify = sql(`SELECT id FROM auth_sessions WHERE id = :session AND write_id = :w`, {
      session: sessionId,
      w: writeId,
    });
    return Object.freeze({
      sessionId,
      token,
      createdAt: input.now,
      expiresAt,
      insert,
      verify,
    });
  }

  /** Creates a session in its own batch; null when the user does not exist or is being deleted. */
  async create(input: {
    readonly userId: string;
    readonly now: number;
  }): Promise<CreatedSession | null> {
    const prepared = this.prepareCreate(input);
    const results = await this.db.batch([prepared.insert, prepared.verify]);
    if (!verifiedRow(results)) return null;
    return Object.freeze({
      sessionId: prepared.sessionId,
      token: prepared.token,
      createdAt: prepared.createdAt,
      expiresAt: prepared.expiresAt,
    });
  }

  /**
   * Resolves a presented token to its live session and the user's access fields with one read-only
   * statement. Malformed tokens return null without a D1 request. The stored digest is compared in
   * constant time under the version it records.
   */
  async resolve(token: unknown, now: number): Promise<ResolvedSession | null> {
    const found = await this.lookup(token, now);
    return found.status === "live" ? found.resolved : null;
  }

  /**
   * Like {@link resolve}, but tells a session that ended (revoked or expired) apart from a token that
   * names no session at all, so callers can limit clients that invent tokens (§5.8) without counting
   * browsers that still hold a stale cookie. Malformed tokens are `unknown` without a D1 request.
   */
  async lookup(token: unknown, now: number): Promise<SessionLookup> {
    if (!isWellFormedSessionToken(token)) return UNKNOWN_SESSION;
    const candidates = computeDigestCandidates(
      this.keys,
      "SESSION_DIGEST_SECRET",
      "session",
      token,
    );
    const row = await this.db.first(
      sql(
        `SELECT s.id AS session_id, s.user_id, s.token_digest, s.digest_version, s.created_at,
                s.last_seen_at, s.expires_at, s.revoked_at, ${accessStateSelectList("u", "u_")}
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_digest IN (:digests)`,
        { digests: candidates.map((candidate) => candidate.digest) },
      ),
    );
    if (!row) return UNKNOWN_SESSION;
    const stored = { version: integer(row, "digest_version"), digest: text(row, "token_digest") };
    if (!verifyDigest(this.keys, "SESSION_DIGEST_SECRET", "session", token, stored)) {
      return UNKNOWN_SESSION;
    }
    const expiresAt = integer(row, "expires_at");
    if (row.revoked_at !== null || expiresAt <= now) return ENDED_SESSION;
    return Object.freeze({
      status: "live",
      resolved: Object.freeze({
        session: Object.freeze({
          id: text(row, "session_id"),
          userId: text(row, "user_id"),
          createdAt: integer(row, "created_at"),
          lastSeenAt: integer(row, "last_seen_at"),
          expiresAt,
        }),
        access: accessStateFromRow(row, "u_"),
      }),
    });
  }

  /** Whether a session read at `now` is due a last-seen write (§5.1). */
  isTouchDue(session: AuthSession, now: number): boolean {
    return now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS;
  }

  /** Records activity at most once per touch interval; a no-op for revoked or expired sessions. */
  async touch(sessionId: string, now: number): Promise<void> {
    await this.db.run(
      sql(
        `UPDATE auth_sessions SET last_seen_at = :now
         WHERE id = :session AND revoked_at IS NULL AND expires_at > :now AND last_seen_at <= :cutoff`,
        { session: sessionId, now: int(now), cutoff: int(now - SESSION_TOUCH_INTERVAL_MS) },
      ),
    );
  }

  /**
   * Revokes one session of a user with every domain's session-bound state (§5.1). Returns true when
   * this call revoked it, false when it was unknown, another user's, or already revoked.
   */
  async revoke(input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly now: number;
  }): Promise<boolean> {
    const writeId = uuidv7(input.now);
    const statements: Statement[] = [
      sql(
        `UPDATE auth_sessions SET revoked_at = :now, write_id = :w
         WHERE id = :session AND user_id = :user AND revoked_at IS NULL`,
        { now: int(input.now), w: writeId, session: input.sessionId, user: input.userId },
      ),
      ...this.contributed({
        userId: input.userId,
        sessionId: input.sessionId,
        now: input.now,
        guard: null,
      }),
      sql(`SELECT id FROM auth_sessions WHERE id = :session AND write_id = :w`, {
        session: input.sessionId,
        w: writeId,
      }),
    ];
    return verifiedRow(await this.db.batch(statements)) !== null;
  }

  /**
   * Statements that revoke every live session of a user, for folding into another batch (account
   * deletion step 5, §5.6). `guard` makes the revocation, and every contributed session-bound
   * revocation, depend on that batch's deciding statement.
   */
  revokeAllStatements(input: {
    readonly userId: string;
    readonly now: number;
    readonly guard?: StatementGuard;
  }): readonly Statement[] {
    const extra = input.guard ? ` AND ${input.guard.exists}` : "";
    return [
      sql(
        `UPDATE auth_sessions SET revoked_at = :now
         WHERE user_id = :user AND revoked_at IS NULL${extra}`,
        { ...input.guard?.params, now: int(input.now), user: input.userId },
      ),
      ...this.contributed({
        userId: input.userId,
        sessionId: null,
        now: input.now,
        guard: input.guard ?? null,
      }),
    ];
  }

  /** Revokes every live session of a user and returns the ids it revoked, for closing their sockets. */
  async revokeAll(input: {
    readonly userId: string;
    readonly now: number;
  }): Promise<readonly string[]> {
    const results: readonly StatementResult[] = await this.db.batch([
      sql(`SELECT id FROM auth_sessions WHERE user_id = :user AND revoked_at IS NULL`, {
        user: input.userId,
      }),
      ...this.revokeAllStatements(input),
    ]);
    return (results[0]?.results ?? []).map((row) => text(row, "id"));
  }

  private contributed(input: SessionRevokeInput): Statement[] {
    const statements: Statement[] = [];
    for (const contributor of this.revokeContributors) {
      for (const statement of contributor.statements(input)) {
        checkRevokeStatement(contributor.domain, statement, input.guard);
        statements.push(statement);
      }
    }
    return statements;
  }
}
