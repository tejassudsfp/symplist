import type { AccountDataKey, KeyProvider, RandomOptions, VersionedDigest } from "@symplist/crypto";
import {
  canonicalJson,
  computeIdempotencyFingerprint,
  decryptFieldText,
  encryptFieldText,
  idempotencyResponseContext,
  verifyDigest,
  zeroize,
} from "@symplist/crypto";
import type { DbClient, DbRow, Statement, StatementResult } from "@symplist/db";
import { int, sql, uuidv7 } from "@symplist/db";
import { AccountKeyStore } from "../account/keys.ts";

/** Records live for 24 hours; an expired key can be used again for a new request (§6.1). */
export const IDEMPOTENCY_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A pending record older than this is treated as abandoned (for example its process died) and may be
 * taken over by an exact retry. Handlers make their effects idempotent by request id or write id
 * (§3.2), so a takeover never applies an effect twice.
 */
export const IDEMPOTENCY_PENDING_LEASE_MS = 2 * 60 * 1000;

/** Longest scope stored (`idempotency_records.scope`). */
export const IDEMPOTENCY_SCOPE_MAX_LENGTH = 200;

/** A replayable response: the HTTP status and the JSON body that was (or, redacted, would be) sent. */
export interface StoredIdempotentResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface IdempotencyRequest {
  /** The operation, for example `POST /v1/tasks/:id/complete`. */
  readonly scope: string;
  readonly userId: string;
  /** The `Idempotency-Key` header value. */
  readonly key: string;
  /** The validated input; only its HMAC fingerprint is stored. */
  readonly input: unknown;
  readonly now: number;
}

/** The claim held by the request that is executing under a key. */
export interface IdempotencyClaim {
  readonly scope: string;
  readonly userId: string;
  readonly key: string;
  readonly writeId: string;
  /** `EXISTS (…)` that holds while this claim is pending, for guarding a folded mutation (§6.1). */
  readonly guard: { readonly exists: string; readonly params: Readonly<Record<string, string>> };
}

export type IdempotencyBeginResult =
  | { readonly kind: "started"; readonly claim: IdempotencyClaim }
  | { readonly kind: "replay"; readonly response: StoredIdempotentResponse }
  | { readonly kind: "mismatch" }
  | { readonly kind: "in_progress" };

/**
 * A claim built to be folded into the caller's own deciding batch (§3.1, §6.1): the claim statements
 * go first, every effect statement is guarded by `claim.guard`, and the batch also carries
 * `completeStatement` for the claim. D1 runs a batch as one transaction, so the record is either
 * absent (and no effect applied) or completed together with the effect: exactly once, in one request.
 */
export interface FoldedIdempotencyClaim {
  readonly claim: IdempotencyClaim;
  /** The claim insert and the record read; place them first in the batch, in this order. */
  readonly statements: readonly Statement[];
}

/** What a folded claim decided, read back from its batch. */
export type FoldedClaimDecision =
  | { readonly kind: "started" }
  | { readonly kind: "replay"; readonly response: StoredIdempotentResponse }
  | { readonly kind: "mismatch" }
  | { readonly kind: "in_progress" };

/** The record or the account key could not be read, or a stored response failed to decrypt. */
export class IdempotencyStateError extends Error {
  readonly code = "idempotency.state_invalid";
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyStateError";
  }
}

export interface IdempotencyStoreOptions {
  readonly db: DbClient;
  readonly keys: KeyProvider;
  readonly random?: RandomOptions;
  readonly ttlMs?: number;
  readonly pendingLeaseMs?: number;
}

function checkRequest(request: Pick<IdempotencyRequest, "scope" | "userId" | "key">): void {
  if (
    typeof request.scope !== "string" ||
    request.scope.length === 0 ||
    request.scope.length > IDEMPOTENCY_SCOPE_MAX_LENGTH
  ) {
    throw new TypeError("Idempotency scopes are 1 to 200 characters");
  }
  if (typeof request.userId !== "string" || request.userId.length === 0) {
    throw new TypeError("Idempotency records belong to a user");
  }
  if (typeof request.key !== "string" || request.key.length === 0 || request.key.length > 255) {
    throw new TypeError("Idempotency keys are 1 to 255 characters");
  }
}

/**
 * The wrapped account key row read by the claiming batch, kept per claim so recording the response
 * needs no second read of `account_keys` (§3.1). It holds only the KEK-wrapped key.
 */
const wrappedKeyRows = new WeakMap<IdempotencyClaim, DbRow>();

function claimGuard(claim: Omit<IdempotencyClaim, "guard">): IdempotencyClaim["guard"] {
  return Object.freeze({
    exists:
      "EXISTS (SELECT 1 FROM idempotency_records WHERE scope = :idem_scope AND user_id = :idem_user AND key = :idem_key AND write_id = :idem_write_id AND status = 'pending')",
    params: Object.freeze({
      idem_scope: claim.scope,
      idem_user: claim.userId,
      idem_key: claim.key,
      idem_write_id: claim.writeId,
    }),
  });
}

function storedFingerprint(row: DbRow): VersionedDigest {
  const { fingerprint, fingerprint_version: version } = row;
  if (typeof fingerprint !== "string" || typeof version !== "number") {
    throw new IdempotencyStateError("Unexpected idempotency record");
  }
  return { digest: fingerprint, version };
}

/**
 * `idempotency_records` (§6.1): an HMAC fingerprint of the validated input under
 * `IDEMPOTENCY_SECRET`, an in-progress claim, and the response as a field envelope under the owner's
 * account data key. An exact retry replays the response; the same key with another input is a
 * mismatch. Responses of one-time secret endpoints are redacted by the caller before they reach
 * {@link completeStatement}.
 */
export class IdempotencyStore {
  private readonly db: DbClient;
  private readonly keys: KeyProvider;
  private readonly accountKeys: AccountKeyStore;
  private readonly random: RandomOptions | undefined;
  private readonly ttlMs: number;
  private readonly pendingLeaseMs: number;

  constructor(options: IdempotencyStoreOptions) {
    this.db = options.db;
    this.keys = options.keys;
    this.accountKeys = new AccountKeyStore({ db: options.db, keys: options.keys });
    this.random = options.random;
    this.ttlMs = options.ttlMs ?? IDEMPOTENCY_RECORD_TTL_MS;
    this.pendingLeaseMs = options.pendingLeaseMs ?? IDEMPOTENCY_PENDING_LEASE_MS;
  }

  /** The fingerprint of a validated input under the current secret version. */
  fingerprint(input: unknown): VersionedDigest {
    return computeIdempotencyFingerprint(this.keys, input);
  }

  /**
   * Claims the key or reads its record in one batch: insert a pending record (or take over an expired
   * record, or an abandoned pending one with the same fingerprint), then read the record and the
   * account key.
   */
  async begin(request: IdempotencyRequest): Promise<IdempotencyBeginResult> {
    const { claim, statements } = this.claimStatements(request, { takeOverAbandoned: true });
    const results = await this.db.batch([
      ...statements,
      this.accountKeys.selectStatement(request.userId),
    ]);
    const row = results[1]?.results[0];
    if (!row) throw new IdempotencyStateError("The user of this idempotency record does not exist");

    if (row.write_id === claim.writeId) {
      const keyRow = results[2]?.results[0];
      if (keyRow) wrappedKeyRows.set(claim, keyRow);
      return { kind: "started", claim };
    }
    return this.decideExisting(request, row, () => {
      const keyRow = results[2]?.results[0];
      if (!keyRow) throw new IdempotencyStateError("The account key of this record is unavailable");
      return this.accountKeys.unwrapRow(keyRow);
    });
  }

  /**
   * The claim of `request` as statements for the caller's deciding batch (§6.1 folding). Unlike
   * {@link begin}, a folded claim never takes over a pending record: a pending folded record can only
   * remain from a batch whose outcome is unknown, so its effect may already have applied, and only an
   * expired record (past the 24-hour replay contract) is claimed again.
   */
  foldedClaim(request: IdempotencyRequest): FoldedIdempotencyClaim {
    return this.claimStatements(request, { takeOverAbandoned: false });
  }

  /**
   * Reads a folded claim's decision from its batch results. `offset` is the index of the first claim
   * statement in the batch. A replay decrypts the recorded response with `accountKey`, the owner's
   * account data key the caller already holds for its own statements.
   */
  decideFoldedClaim(input: {
    readonly request: IdempotencyRequest;
    readonly folded: FoldedIdempotencyClaim;
    readonly results: readonly StatementResult[];
    readonly accountKey: AccountDataKey;
    readonly offset?: number;
  }): FoldedClaimDecision {
    const row = input.results[(input.offset ?? 0) + 1]?.results[0];
    if (!row) throw new IdempotencyStateError("The user of this idempotency record does not exist");
    if (row.write_id === input.folded.claim.writeId) return { kind: "started" };
    return this.decideExisting(input.request, row, () => input.accountKey, { borrowedKey: true });
  }

  private claimStatements(
    request: IdempotencyRequest,
    options: { readonly takeOverAbandoned: boolean },
  ): FoldedIdempotencyClaim {
    checkRequest(request);
    const writeId = uuidv7(request.now);
    const fingerprint = this.fingerprint(request.input);
    const record = { scope: request.scope, user: request.userId, key: request.key };
    const takeover = options.takeOverAbandoned
      ? `
            OR (idempotency_records.status = 'pending'
                AND idempotency_records.updated_at <= :lease_cutoff
                AND idempotency_records.fingerprint = excluded.fingerprint
                AND idempotency_records.fingerprint_version = excluded.fingerprint_version)`
      : "";
    const statements: Statement[] = [
      sql(
        `INSERT INTO idempotency_records
           (scope, user_id, key, fingerprint, fingerprint_version, status, http_status, response_enc,
            created_at, updated_at, expires_at, write_id)
         SELECT :scope, :user, :key, :fingerprint, :version, 'pending', NULL, NULL, :now, :now,
                :expires, :w
         WHERE EXISTS (SELECT 1 FROM users WHERE id = :user)
         ON CONFLICT (scope, user_id, key) DO UPDATE SET
           fingerprint = excluded.fingerprint, fingerprint_version = excluded.fingerprint_version,
           status = 'pending', http_status = NULL, response_enc = NULL,
           created_at = excluded.created_at, updated_at = excluded.updated_at,
           expires_at = excluded.expires_at, write_id = excluded.write_id
         WHERE idempotency_records.expires_at <= excluded.created_at${takeover}`,
        {
          ...record,
          fingerprint: fingerprint.digest,
          version: int(fingerprint.version),
          now: int(request.now),
          expires: int(request.now + this.ttlMs),
          w: writeId,
          ...(options.takeOverAbandoned
            ? { lease_cutoff: int(request.now - this.pendingLeaseMs) }
            : {}),
        },
      ),
      sql(
        `SELECT fingerprint, fingerprint_version, status, http_status, response_enc, write_id
         FROM idempotency_records WHERE scope = :scope AND user_id = :user AND key = :key`,
        record,
      ),
    ];
    const fields = { scope: request.scope, userId: request.userId, key: request.key, writeId };
    const claim: IdempotencyClaim = Object.freeze({ ...fields, guard: claimGuard(fields) });
    return Object.freeze({ claim, statements: Object.freeze(statements) });
  }

  /** The decision for a record another request claimed: mismatch, in progress or replay. */
  private decideExisting(
    request: IdempotencyRequest,
    row: DbRow,
    accountKey: () => AccountDataKey,
    options: { readonly borrowedKey?: boolean } = {},
  ): Exclude<FoldedClaimDecision, { readonly kind: "started" }> {
    const matches = verifyDigest(
      this.keys,
      "IDEMPOTENCY_SECRET",
      "idem",
      canonicalJson(request.input),
      storedFingerprint(row),
    );
    if (!matches) return { kind: "mismatch" };
    if (row.status !== "completed") return { kind: "in_progress" };
    const key = accountKey();
    try {
      return { kind: "replay", response: this.decryptResponse(key, request, row) };
    } finally {
      // A key the caller lent stays usable for the caller; a key unwrapped here is zeroised.
      if (!options.borrowedKey) zeroize(key.key);
    }
  }

  /**
   * Records the response of a claim. Fold it into the mutation's batch when the response is known
   * before the batch runs, or run it with {@link complete} after the handler returned.
   */
  completeStatement(input: {
    readonly claim: IdempotencyClaim;
    readonly response: StoredIdempotentResponse;
    readonly accountKey: AccountDataKey;
    readonly now: number;
  }): Statement {
    const { claim, response } = input;
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      throw new TypeError("Idempotent responses need an HTTP status");
    }
    const plaintext = JSON.stringify({ status: response.status, body: response.body ?? null });
    const envelope = encryptFieldText(
      input.accountKey,
      idempotencyResponseContext(claim.userId, claim.scope, claim.key),
      plaintext,
      this.random,
    );
    return sql(
      `UPDATE idempotency_records
       SET status = 'completed', http_status = :status, response_enc = :enc, updated_at = :now
       WHERE scope = :idem_scope AND user_id = :idem_user AND key = :idem_key
         AND write_id = :idem_write_id AND status = 'pending'`,
      {
        ...claim.guard.params,
        status: int(response.status),
        enc: envelope,
        now: int(input.now),
      },
    );
  }

  /**
   * Records the response of a claim in its own batch: one D1 request, reusing the account key row the
   * claiming batch already read.
   */
  async complete(input: {
    readonly claim: IdempotencyClaim;
    readonly response: StoredIdempotentResponse;
    readonly now: number;
  }): Promise<void> {
    const keyRow = wrappedKeyRows.get(input.claim);
    const accountKey = keyRow
      ? this.accountKeys.unwrapRow(keyRow)
      : await this.accountKeys.require(input.claim.userId);
    try {
      await this.db.run(this.completeStatement({ ...input, accountKey }));
    } finally {
      zeroize(accountKey.key);
    }
  }

  /** Deletes a pending claim after its request failed without an effect, so a retry runs again. */
  async release(claim: IdempotencyClaim): Promise<void> {
    await this.db.run(
      sql(
        `DELETE FROM idempotency_records
         WHERE scope = :idem_scope AND user_id = :idem_user AND key = :idem_key
           AND write_id = :idem_write_id AND status = 'pending'`,
        claim.guard.params,
      ),
    );
  }

  /** Deletes up to `limit` expired records; for the hourly cleanup. */
  expiredDeletionStatement(now: number, limit: number): Statement {
    return sql(
      `DELETE FROM idempotency_records WHERE rowid IN (
         SELECT rowid FROM idempotency_records WHERE expires_at <= :now LIMIT CAST(:limit AS INTEGER))`,
      { now: int(now), limit: int(limit) },
    );
  }

  private decryptResponse(
    accountKey: AccountDataKey,
    request: IdempotencyRequest,
    row: DbRow,
  ): StoredIdempotentResponse {
    if (typeof row.response_enc !== "string") {
      throw new IdempotencyStateError("A completed idempotency record has no response");
    }
    const text = decryptFieldText(
      accountKey,
      idempotencyResponseContext(request.userId, request.scope, request.key),
      row.response_enc,
    );
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { status?: unknown }).status !== "number"
    ) {
      throw new IdempotencyStateError("A stored idempotent response is malformed");
    }
    const { status, body } = parsed as { status: number; body: unknown };
    return Object.freeze({ status, body });
  }
}
