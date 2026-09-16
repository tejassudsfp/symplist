import type {
  SharingGrant,
  SharingGrantRequest,
  SharingProposalRequest,
  SharingRelease,
} from "@symplist/contracts";
import { computeDigest, generateToken, hashArgon2id, zeroize } from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { actorGuards, authorizeActor, type DocumentActor } from "../documents/actor.ts";
import { grantView, sharingDecrypt, sharingEncrypt } from "./fields.ts";
import type { SharingRepository } from "./repository.ts";
import { SharingError, type SharingFold } from "./types.ts";

const DAY = 86_400_000;

export class SharingGrants {
  constructor(readonly repository: SharingRepository) {}

  validateExpiry(mode: string, expiresAt: number | null): void {
    const now = this.repository.options.now();
    if (
      expiresAt === null
        ? mode !== "public"
        : !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 7 * DAY
    )
      throw new SharingError("sharing.expiry_invalid");
  }

  /** Simon/MCP may propose access, never mint a token. The trusted UI supplies the password later. */
  async propose(actor: DocumentActor, input: SharingProposalRequest, requestId: string) {
    const repo = this.repository;
    this.validateExpiry(input.mode, input.expiresAt);
    const loaded = await repo.loadArtifact(actor.userId, input.artifactId, [
      sql("SELECT * FROM share_approvals WHERE owner_id = :owner AND request_id = :request", {
        owner: actor.userId,
        request: requestId,
      }),
    ]);
    try {
      const taskId = String(loaded.row.task_id);
      authorizeActor(actor, taskId, "write");
      const fingerprint = repo.fingerprint(input);
      const previous = loaded.extra[0]?.results[0];
      if (previous) {
        if (
          sharingDecrypt(
            loaded.key,
            "share_approvals",
            String(previous.id),
            "fingerprint_enc",
            String(previous.fingerprint_enc),
          ) !== fingerprint
        )
          throw new SharingError("idempotency.mismatch");
        return { proposalId: String(previous.id), status: String(previous.status) };
      }
      if (loaded.row.current_head !== input.expectedHead) throw new SharingError("sharing.stale");
      const id = uuidv7();
      const write = uuidv7();
      const now = repo.options.now();
      const guard = repo.guards(repo.active(actor.userId, taskId), ...actorGuards(actor), {
        sql: "EXISTS (SELECT 1 FROM doc_repos WHERE task_id = :task AND owner_id = :owner AND head_commit_id = :head)",
        params: { task: taskId, owner: actor.userId, head: input.expectedHead },
      });
      return await repo.write({
        key: loaded.key,
        body: { proposalId: id, status: "pending" },
        effect: repo.effect("share_approvals", id, write),
        statements: [
          sql(
            `INSERT INTO share_approvals (id, owner_id, artifact_id, expected_head, mode, grant_expires_at, password_required, request_id, fingerprint_enc, created_at, expires_at, write_id)
          SELECT :id, :owner, :artifact, :head, :mode, :expiry, :password, :request, :fingerprint, :now, :proposal_expiry, :write WHERE ${guard.sql}`,
            {
              ...guard.params,
              id,
              artifact: input.artifactId,
              mode: input.mode,
              expiry: input.expiresAt === null ? null : int(input.expiresAt),
              password: input.mode === "password" ? "1" : "0",
              request: requestId,
              fingerprint: sharingEncrypt(
                loaded.key,
                "share_approvals",
                id,
                "fingerprint_enc",
                fingerprint,
              ),
              now: int(now),
              proposal_expiry: int(now + DAY),
              write,
            },
          ),
        ],
      });
    } finally {
      zeroize(loaded.key.key);
    }
  }

  /** This method is bound only to an app-class owner endpoint. It is never a tool. */
  async release(
    owner: string,
    artifactId: string,
    input: SharingGrantRequest,
    fold: SharingFold,
  ): Promise<SharingRelease> {
    const repo = this.repository;
    this.validateExpiry(input.mode, input.expiresAt);
    if (input.mode === "public" && !input.publicConfirmed) throw new SharingError("validation");
    if ((input.mode === "password") !== (input.password !== undefined))
      throw new SharingError("validation");
    const loaded = await repo.loadArtifact(owner, artifactId);
    try {
      const now = repo.options.now();
      const id = uuidv7();
      const write = uuidv7();
      const raw = input.mode === "public" ? null : generateToken();
      const digest = raw
        ? computeDigest(repo.options.keys, "SHARE_DIGEST_SECRET", "share-token", raw)
        : null;
      const publication = input.mode === "public" ? uuidv7() : null;
      const passwordHash =
        input.password === undefined ? null : JSON.stringify(await hashArgon2id(input.password));
      const guards = [
        repo.active(owner, String(loaded.row.task_id)),
        fold.guard,
        {
          sql: "EXISTS (SELECT 1 FROM doc_repos WHERE owner_id = :release_owner AND task_id = :release_task AND head_commit_id = :release_head)",
          params: {
            release_owner: owner,
            release_task: String(loaded.row.task_id),
            release_head: input.expectedHead,
          },
        },
      ];
      if (input.proposalId)
        guards.push({
          sql: `EXISTS (SELECT 1 FROM share_approvals WHERE id = :proposal AND owner_id = :proposal_owner AND artifact_id = :proposal_artifact AND expected_head = :proposal_head AND mode = :proposal_mode AND ${input.expiresAt === null ? "grant_expires_at IS NULL" : "grant_expires_at = CAST(:proposal_expiry AS INTEGER)"} AND password_required = CAST(:proposal_password AS INTEGER) AND status = 'pending' AND expires_at > :proposal_now)`,
          params: {
            proposal: input.proposalId,
            proposal_owner: owner,
            proposal_artifact: artifactId,
            proposal_head: input.expectedHead,
            proposal_mode: input.mode,
            ...(input.expiresAt === null ? {} : { proposal_expiry: int(input.expiresAt) }),
            proposal_password: input.mode === "password" ? "1" : "0",
            proposal_now: int(now),
          },
        });
      if (input.replaceGrantId)
        guards.push({
          sql: "EXISTS (SELECT 1 FROM share_grants WHERE id = :replace AND owner_id = :replace_owner AND artifact_id = :replace_artifact)",
          params: {
            replace: input.replaceGrantId,
            replace_owner: owner,
            replace_artifact: artifactId,
          },
        });
      const guard = repo.guards(...guards);
      const effect = repo.effect("share_grants", id, write);
      const grant: SharingGrant = {
        id,
        artifactId,
        mode: input.mode,
        status: "active",
        disabledReason: null,
        expiresAt: input.expiresAt,
        createdAt: now,
        generation: 1,
      };
      const url =
        input.mode === "public"
          ? `${repo.options.artifactOrigin}/artifact/${artifactId}/public/${publication}`
          : `${repo.options.artifactOrigin}/artifact/${artifactId}?key=${raw}`;
      return await repo.write({
        key: loaded.key,
        body: { grant, url, secretUnavailable: false } as SharingRelease,
        effect,
        fold,
        statements: [
          sql(
            `INSERT INTO share_grants (id, owner_id, artifact_id, mode, token_digest, token_version, publication_id, password_hash, expires_at, created_at, write_id)
          SELECT :id, :owner, :artifact, :mode, :digest, :version, :publication, :password, :expiry, :now, :write WHERE ${guard.sql}`,
            {
              ...guard.params,
              id,
              owner,
              artifact: artifactId,
              mode: input.mode,
              digest: digest?.digest ?? null,
              version: digest ? int(digest.version) : null,
              publication,
              password: passwordHash,
              expiry: input.expiresAt === null ? null : int(input.expiresAt),
              now: int(now),
              write,
            },
          ),
          ...(input.proposalId
            ? [
                sql(
                  `UPDATE share_approvals SET status = 'released', write_id = :write WHERE id = :proposal AND owner_id = :owner AND ${effect.sql}`,
                  { ...effect.params, write, proposal: input.proposalId, owner },
                ),
              ]
            : []),
          ...(input.revokeReplaced && input.replaceGrantId
            ? [
                sql(
                  `UPDATE share_grants SET status = 'revoked', generation = generation + 1, write_id = :write WHERE id = :old AND owner_id = :owner AND ${effect.sql}`,
                  { ...effect.params, write, old: input.replaceGrantId, owner },
                ),
              ]
            : []),
          sql(
            `INSERT INTO share_audit (id, owner_id, artifact_id, grant_id, action, created_at) SELECT :audit, :owner, :artifact, :id, 'release', :now WHERE ${effect.sql}`,
            { ...effect.params, audit: uuidv7(), owner, artifact: artifactId, id, now: int(now) },
          ),
        ],
      });
    } finally {
      zeroize(loaded.key.key);
    }
  }

  async revoke(
    actor: DocumentActor,
    artifactId: string,
    grantId: string,
    fold?: SharingFold,
  ): Promise<SharingGrant> {
    const repo = this.repository;
    const loaded = await repo.loadArtifact(actor.userId, artifactId, [
      sql(
        "SELECT * FROM share_grants WHERE id = :grant AND artifact_id = :artifact AND owner_id = :owner",
        { grant: grantId, artifact: artifactId, owner: actor.userId },
      ),
    ]);
    try {
      authorizeActor(actor, String(loaded.row.task_id), "write");
      const previous = loaded.extra[0]?.results[0];
      if (!previous) throw new SharingError("not_found");
      const write = uuidv7();
      const now = repo.options.now();
      const guard = repo.guards(repo.access(actor.userId), ...actorGuards(actor), fold?.guard);
      const effect = repo.effect("share_grants", grantId, write);
      const body = {
        ...grantView(previous, now),
        status: "revoked" as const,
        generation: Number(previous.generation) + (previous.status === "revoked" ? 0 : 1),
      };
      return await repo.write({
        key: loaded.key,
        body,
        effect,
        ...(fold ? { fold } : {}),
        statements: [
          sql(
            `UPDATE share_grants SET status = 'revoked', generation = generation + CASE WHEN status = 'revoked' THEN 0 ELSE 1 END, write_id = :write WHERE id = :grant AND owner_id = :owner AND artifact_id = :artifact AND ${guard.sql}`,
            { ...guard.params, write, grant: grantId, owner: actor.userId, artifact: artifactId },
          ),
          sql(
            `UPDATE share_sessions SET revoked_at = :now, write_id = :write WHERE grant_id = :grant AND owner_id = :owner AND revoked_at IS NULL AND ${effect.sql}`,
            { ...effect.params, now: int(now), write, grant: grantId, owner: actor.userId },
          ),
          sql(
            `INSERT INTO share_audit (id, owner_id, artifact_id, grant_id, action, created_at) SELECT :audit, :owner, :artifact, :grant, 'revoke', :now WHERE ${effect.sql}`,
            {
              ...effect.params,
              audit: uuidv7(),
              owner: actor.userId,
              artifact: artifactId,
              grant: grantId,
              now: int(now),
            },
          ),
        ],
      });
    } finally {
      zeroize(loaded.key.key);
    }
  }
}
