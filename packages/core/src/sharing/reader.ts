import {
  canonicalJson,
  computeDigest,
  computeDigestCandidates,
  generateToken,
  parseArgon2idHash,
  RateLimitedError,
  verifyArgon2id,
  verifyDigest,
  zeroize,
} from "@symplist/crypto";
import { type DbRow, int, sql, uuidv7 } from "@symplist/db";
import { artifactView } from "./fields.ts";
import type { SharingRepository } from "./repository.ts";
import { SharingError } from "./types.ts";

export interface ShareReadInput {
  readonly artifactId: string;
  readonly key?: string;
  readonly publicationId?: string;
  readonly cookies?: Readonly<Record<string, string>>;
}
export type ShareReadResult =
  | { readonly kind: "password"; readonly grantId: string; readonly nonce: string }
  | {
      readonly kind: "content";
      readonly title: string;
      readonly markdown: string;
      readonly sourceRevision: string;
      readonly createdAt: number;
      readonly expiresAt: number | null;
    };
interface ShareSessionProof {
  readonly id: string;
  readonly candidates: string;
}

export class SharingReader {
  private readonly unknown = new Map<string, number>();
  constructor(readonly repository: SharingRepository) {}

  private active(alias = "g"): string {
    const access = this.repository
      .access("unused")
      .sql.replaceAll(":share_owner", `${alias}.owner_id`);
    return `${alias}.status = 'active' AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > :now) AND ${access}
      AND EXISTS (SELECT 1 FROM artifacts WHERE id = ${alias}.artifact_id AND deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM account_keys WHERE owner_id = ${alias}.owner_id)`;
  }

  private async resolve(input: ShareReadInput): Promise<DbRow> {
    const repo = this.repository;
    const now = repo.options.now();
    if (input.publicationId && input.key) throw new SharingError("sharing.unavailable");
    let lookup: string;
    let params: Record<string, string>;
    if (input.publicationId) {
      lookup = "g.mode = 'public' AND g.publication_id = :publication";
      params = { publication: input.publicationId };
    } else {
      if (!input.key || !/^[A-Za-z0-9_-]{43}$/.test(input.key))
        throw new SharingError("sharing.unavailable");
      const candidates = computeDigestCandidates(
        repo.options.keys,
        "SHARE_DIGEST_SECRET",
        "share-token",
        input.key,
      );
      lookup =
        "g.mode IN ('link', 'password') AND EXISTS (SELECT 1 FROM json_each(:candidates) c WHERE json_extract(c.value, '$.digest') = g.token_digest AND json_extract(c.value, '$.version') = g.token_version)";
      params = { candidates: JSON.stringify(candidates) };
      const cacheKey = `${input.artifactId}:${candidates[0]?.digest}`;
      if ((this.unknown.get(cacheKey) ?? 0) > now) throw new SharingError("sharing.unavailable");
    }
    const row = await repo.options.db.first(
      sql(
        `SELECT a.*, g.id AS grant_id, g.mode AS grant_mode, g.generation AS grant_generation, g.expires_at AS grant_expires_at,
        g.token_digest AS grant_token_digest, g.token_version AS grant_token_version, g.publication_id AS grant_publication_id,
        g.password_hash, k.kek_version, k.wrapped_key
      FROM share_grants g JOIN artifacts a ON a.id = g.artifact_id AND a.owner_id = g.owner_id JOIN account_keys k ON k.owner_id = a.owner_id
      WHERE a.id = :artifact AND ${lookup} AND ${this.active()}`,
        { ...params, artifact: input.artifactId, now: int(now) },
      ),
      { priority: "unauthenticated" },
    );
    if (!row) {
      if (input.key) {
        const digest = computeDigest(
          repo.options.keys,
          "SHARE_DIGEST_SECRET",
          "share-token",
          input.key,
        );
        if (this.unknown.size >= 2000) {
          const first = this.unknown.keys().next().value;
          if (first) this.unknown.delete(first);
        }
        this.unknown.set(`${input.artifactId}:${digest.digest}`, now + 60_000);
      }
      throw new SharingError("sharing.unavailable");
    }
    return row;
  }

  private async reauthorize(row: DbRow, session?: ShareSessionProof): Promise<void> {
    const mode = String(row.grant_mode);
    const credential =
      mode === "public"
        ? "g.publication_id = :publication"
        : "g.token_digest = :token_digest AND g.token_version = CAST(:token_version AS INTEGER)";
    const passwordSession =
      mode === "password"
        ? `AND EXISTS (SELECT 1 FROM share_sessions s WHERE s.id = :session AND s.owner_id = g.owner_id
          AND s.grant_id = g.id AND s.grant_generation = g.generation AND s.revoked_at IS NULL AND s.expires_at > :now
          AND EXISTS (SELECT 1 FROM json_each(:session_candidates) c WHERE json_extract(c.value, '$.digest') = s.digest AND json_extract(c.value, '$.version') = s.digest_version))`
        : "";
    if (mode === "password" && !session) throw new SharingError("sharing.unavailable");
    const allowed = await this.repository.options.db.first(
      sql(
        `SELECT 1 AS allowed FROM share_grants g
        JOIN artifacts a ON a.id = g.artifact_id AND a.owner_id = g.owner_id
        JOIN account_keys k ON k.owner_id = g.owner_id
        WHERE g.id = :grant AND g.owner_id = :owner AND g.artifact_id = :artifact
        AND g.mode = :mode AND g.generation = CAST(:generation AS INTEGER)
        AND COALESCE(g.expires_at,-1) = CAST(:expires AS INTEGER) AND ${credential}
        AND a.object_key = :object AND a.source_revision = :revision
        AND k.kek_version = CAST(:kek_version AS INTEGER) AND k.wrapped_key = :wrapped_key
        AND ${this.active()} ${passwordSession}`,
        {
          grant: String(row.grant_id),
          owner: String(row.owner_id),
          artifact: String(row.id),
          mode,
          generation: int(Number(row.grant_generation)),
          expires: int(row.grant_expires_at === null ? -1 : Number(row.grant_expires_at)),
          object: String(row.object_key),
          revision: String(row.source_revision),
          kek_version: int(Number(row.kek_version)),
          wrapped_key: String(row.wrapped_key),
          now: int(this.repository.options.now()),
          ...(mode === "public"
            ? { publication: String(row.grant_publication_id) }
            : {
                token_digest: String(row.grant_token_digest),
                token_version: int(Number(row.grant_token_version)),
              }),
          ...(mode === "password" && session
            ? { session: session.id, session_candidates: session.candidates }
            : {}),
        },
      ),
      { priority: "unauthenticated" },
    );
    if (!allowed) throw new SharingError("sharing.unavailable");
  }

  private nonce(row: DbRow): string {
    const now = this.repository.options.now();
    const random = generateToken(16);
    const value = canonicalJson([row.grant_id, row.grant_generation, now, random]);
    const digest = computeDigest(
      this.repository.options.keys,
      "SHARE_DIGEST_SECRET",
      "share-form",
      value,
    );
    return `${digest.version}.${now}.${random}.${digest.digest}`;
  }
  private nonceValid(row: DbRow, nonce: string): boolean {
    const parts = nonce.split(".");
    if (
      parts.length !== 4 ||
      !/^\d+$/.test(parts[0] ?? "") ||
      !/^\d+$/.test(parts[1] ?? "") ||
      !/^[A-Za-z0-9_-]{22}$/.test(parts[2] ?? "")
    )
      return false;
    const at = Number(parts[1]);
    const now = this.repository.options.now();
    if (!Number.isSafeInteger(at) || at > now || at <= now - 600_000) return false;
    try {
      return verifyDigest(
        this.repository.options.keys,
        "SHARE_DIGEST_SECRET",
        "share-form",
        canonicalJson([row.grant_id, row.grant_generation, at, parts[2]]),
        { version: Number(parts[0]), digest: parts[3] ?? "" },
      );
    } catch {
      return false;
    }
  }

  async read(input: ShareReadInput): Promise<ShareReadResult> {
    const row = await this.resolve(input);
    let session: ShareSessionProof | undefined;
    if (row.grant_mode === "password") {
      const cookie = input.cookies?.[`__Host-sym_share_${row.grant_id}`];
      if (cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie)) {
        const candidates = computeDigestCandidates(
          this.repository.options.keys,
          "SHARE_SESSION_DIGEST_SECRET",
          "share-session",
          cookie,
        );
        const proof = await this.repository.options.db.first(
          sql(
            `SELECT s.id FROM share_sessions s JOIN share_grants g ON g.id = s.grant_id
          WHERE s.grant_id = :grant AND s.grant_generation = g.generation AND s.revoked_at IS NULL AND s.expires_at > :now AND ${this.active()}
          AND EXISTS (SELECT 1 FROM json_each(:candidates) c WHERE json_extract(c.value, '$.digest') = s.digest AND json_extract(c.value, '$.version') = s.digest_version)`,
            {
              grant: String(row.grant_id),
              now: int(this.repository.options.now()),
              candidates: JSON.stringify(candidates),
            },
          ),
          { priority: "unauthenticated" },
        );
        if (proof) session = { id: String(proof.id), candidates: JSON.stringify(candidates) };
      }
      if (!session)
        return { kind: "password", grantId: String(row.grant_id), nonce: this.nonce(row) };
    }
    const key = this.repository.accountKeys.unwrapRow(row);
    try {
      const markdown = await this.repository.content(row, key, () =>
        this.reauthorize(row, session),
      );
      return {
        kind: "content",
        title: artifactView({ ...row, current_head: null }, key).title,
        markdown,
        sourceRevision: String(row.source_revision),
        createdAt: Number(row.created_at),
        expiresAt: row.grant_expires_at as number | null,
      };
    } finally {
      zeroize(key.key);
    }
  }

  async password(input: {
    artifactId: string;
    key: string;
    nonce: string;
    password: string;
    ip: string;
  }) {
    const row = await this.resolve(input);
    if (row.grant_mode !== "password" || !this.nonceValid(row, input.nonce))
      throw new SharingError("sharing.unavailable");
    const repo = this.repository;
    const now = repo.options.now();
    const write = uuidv7();
    const grant = String(row.grant_id);
    const owner = String(row.owner_id);
    // Hash IP with an existing purpose-separated key; raw addresses never enter D1.
    const ip = computeDigest(
      repo.options.keys,
      "SHARE_DIGEST_SECRET",
      "share-form",
      canonicalJson(["password-ip", input.ip]),
    ).digest;
    const windows = [
      { bucket: `ip:${ip}`, start: Math.floor(now / 900_000) * 900_000, limit: 5 },
      { bucket: "all", start: Math.floor(now / 86_400_000) * 86_400_000, limit: 50 },
    ];
    const [perIp, global] = windows;
    if (!perIp || !global) throw new SharingError("internal");
    // Reserve capacity before expensive verification. Concurrent requests cannot exceed either cap.
    const results = await repo.options.db.batch(
      [
        sql(
          `INSERT INTO share_limits (grant_id, owner_id, bucket, window_start, attempts, write_id)
        SELECT :grant, :owner, :bucket, :start, 1, :write WHERE
        COALESCE((SELECT attempts FROM share_limits WHERE grant_id = :grant AND bucket = 'all' AND window_start = :day), 0) < 50
        ON CONFLICT (grant_id, bucket, window_start) DO UPDATE SET attempts = attempts + 1, write_id = :write WHERE attempts < 5`,
          {
            grant,
            owner,
            bucket: perIp.bucket,
            start: int(perIp.start),
            day: int(global.start),
            write,
          },
        ),
        sql(
          `INSERT INTO share_limits (grant_id, owner_id, bucket, window_start, attempts, write_id)
        SELECT :grant, :owner, 'all', :day, 1, :write WHERE EXISTS (SELECT 1 FROM share_limits WHERE grant_id = :grant AND bucket = :bucket AND window_start = :start AND write_id = :write)
        ON CONFLICT (grant_id, bucket, window_start) DO UPDATE SET attempts = attempts + 1, write_id = :write WHERE attempts < 50`,
          {
            grant,
            owner,
            day: int(global.start),
            write,
            bucket: perIp.bucket,
            start: int(perIp.start),
          },
        ),
        sql(
          "SELECT 1 AS reserved FROM share_limits WHERE grant_id = :grant AND bucket = 'all' AND window_start = :day AND write_id = :write",
          { grant, day: int(global.start), write },
        ),
      ],
      { priority: "unauthenticated" },
    );
    if (!results[2]?.results[0]) throw new SharingError("rate.limited");
    let valid = false;
    try {
      valid = await verifyArgon2id(
        input.password,
        parseArgon2idHash(JSON.parse(String(row.password_hash))),
      );
    } catch (error) {
      if (error instanceof RateLimitedError) throw new SharingError("rate.limited");
      throw new SharingError("sharing.password_invalid");
    }
    if (!valid) throw new SharingError("sharing.password_invalid");
    const token = generateToken();
    const digest = computeDigest(
      repo.options.keys,
      "SHARE_SESSION_DIGEST_SECRET",
      "share-session",
      token,
    );
    const expires = Math.min(now + 43_200_000, Number(row.grant_expires_at));
    const session = uuidv7();
    const commit = await repo.options.db.batch(
      [
        sql(
          `INSERT INTO share_sessions (id, owner_id, grant_id, grant_generation, digest, digest_version, expires_at, created_at, write_id)
        SELECT :session, g.owner_id, g.id, g.generation, :digest, :version, :expires, :now, :write FROM share_grants g WHERE g.id = :grant AND g.generation = CAST(:generation AS INTEGER) AND ${this.active()}`,
          {
            session,
            digest: digest.digest,
            version: int(digest.version),
            expires: int(expires),
            now: int(repo.options.now()),
            write,
            grant,
            generation: int(Number(row.grant_generation)),
          },
        ),
        ...windows.map((window) =>
          sql(
            `UPDATE share_limits SET attempts = MAX(0, attempts - 1) WHERE grant_id = :grant AND bucket = :bucket AND window_start = :start AND EXISTS (SELECT 1 FROM share_sessions WHERE id = :session AND write_id = :write)`,
            { grant, bucket: window.bucket, start: int(window.start), session, write },
          ),
        ),
        sql("SELECT id FROM share_sessions WHERE id = :session AND write_id = :write", {
          session,
          write,
        }),
      ],
      { priority: "unauthenticated" },
    );
    if (!commit.at(-1)?.results[0]) throw new SharingError("sharing.unavailable");
    return {
      cookieName: `__Host-sym_share_${grant}`,
      token,
      maxAgeSeconds: Math.max(0, Math.floor((expires - repo.options.now()) / 1000)),
    };
  }
}
