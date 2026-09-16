import {
  type HandoffRequest,
  handoffRequestSchema,
  idSchema,
  type SharingArtifact,
  type SharingListQuery,
  type SharingProposalRequest,
  type SharingSnapshotRequest,
  sharingListQuerySchema,
  sharingProposalRequestSchema,
  sharingSnapshotRequestSchema,
} from "@symplist/contracts";
import { sql } from "@symplist/db";
import { actorGuards } from "../documents/actor.ts";
import { IdempotencyStore } from "../idempotency/store.ts";
import {
  SharingError,
  type SharingFold,
  SharingGrants,
  type SharingOptions,
  SharingRepository,
} from "../sharing/index.ts";
import type { SimonDocumentSession } from "./documents.ts";

export type SimonSharingOptions = Pick<
  SharingOptions,
  "objects" | "privateOrigins" | "maxBytes" | "onGrantChanged" | "onConfirmed"
>;

/** Model-visible references deliberately exclude content, titles, tokens, passwords and URLs. */
function reference(artifact: SharingArtifact) {
  return {
    artifactId: artifact.id,
    taskId: artifact.taskId,
    revision: artifact.sourceRevision,
    currentHead: artifact.currentHead,
    sectionIds: artifact.sectionIds,
    kind: artifact.kind,
    bytes: artifact.bytes,
    createdAt: artifact.createdAt,
  };
}

/** Uses the same trusted actor and existing private snapshot/handoff services as document tools. */
export class SimonSharingSession {
  readonly repository: SharingRepository;
  readonly grants: SharingGrants;
  constructor(
    readonly documents: SimonDocumentSession,
    options: SimonSharingOptions,
  ) {
    // ARTIFACT_ORIGIN belongs only to the API. Native tools never call release or construct URLs.
    this.repository = new SharingRepository({
      ...documents.repository.options,
      ...options,
      artifactOrigin: "",
    });
    this.grants = new SharingGrants(this.repository);
  }
  private request(toolCallId: string) {
    const actor = this.documents.actor(toolCallId);
    return { actor, id: `simon:${actor.runId}:${actor.toolCallId}` };
  }
  async snapshot(taskId: string, raw: SharingSnapshotRequest, toolCallId: string) {
    const input = sharingSnapshotRequestSchema.parse(raw);
    const { actor, id } = this.request(toolCallId);
    return reference(await this.repository.snapshot(actor, idSchema.parse(taskId), input, id));
  }
  async handoff(taskId: string, raw: HandoffRequest, toolCallId: string) {
    const input = handoffRequestSchema.parse(raw);
    const { actor, id } = this.request(toolCallId);
    const artifact = await this.repository.snapshot(
      actor,
      idSchema.parse(taskId),
      { title: input.title, revision: input.revision, sectionIds: [] },
      id,
      undefined,
      input,
    );
    return {
      ...reference(artifact),
      status: "draft" as const,
      target: input.target,
      artifactIds: input.artifactIds,
    };
  }
  propose(raw: SharingProposalRequest, toolCallId: string) {
    const { actor, id } = this.request(toolCallId);
    return this.grants.propose(actor, sharingProposalRequestSchema.parse(raw), id);
  }
  async list(taskId: string, query: SharingListQuery, toolCallId: string) {
    const { actor } = this.request(toolCallId);
    const result = await this.repository.list(
      actor,
      idSchema.parse(taskId),
      sharingListQuerySchema.parse(query),
    );
    return {
      ...result,
      artifacts: result.artifacts.map(reference),
      grants: result.grants.map((grant) => ({
        grantId: grant.id,
        artifactId: grant.artifactId,
        mode: grant.mode,
        status: grant.status,
        expiresAt: grant.expiresAt,
        generation: grant.generation,
      })),
    };
  }
  async revoke(artifactId: string, grantId: string, toolCallId: string) {
    const { actor } = this.request(toolCallId);
    const input = { artifactId: idSchema.parse(artifactId), grantId: idSchema.parse(grantId) };
    const repo = this.repository;
    const now = repo.options.now();
    const store = new IdempotencyStore({ ...repo.options, ttlMs: Number.MAX_SAFE_INTEGER - now });
    const request = {
      scope: "simon.native.sharing",
      userId: actor.userId,
      key: `${actor.runId}:${actor.toolCallId}`,
      input: { tool: "artifact_share_revoke", ...input },
      now,
    };
    const folded = store.foldedClaim(request);
    const fold: SharingFold = {
      get prefix() {
        const authority = repo.guards(repo.access(actor.userId), ...actorGuards(actor));
        return [
          ...folded.statements,
          sql(`SELECT 1 AS allowed WHERE ${authority.sql}`, authority.params),
        ];
      },
      guard: { sql: folded.claim.guard.exists, params: folded.claim.guard.params },
      complete: (body, key, effect) => [
        store.completeStatement({
          claim: folded.claim,
          response: { status: 200, body },
          accountKey: key,
          now: repo.options.now(),
        }),
        sql(
          `DELETE FROM idempotency_records WHERE scope=:idem_scope AND user_id=:idem_user AND key=:idem_key AND write_id=:idem_write_id AND NOT (${effect.sql})`,
          { ...folded.claim.guard.params, ...effect.params },
        ),
      ],
      decide: (results, key) => {
        if (!results[2]?.results[0]) throw new SharingError("not_found");
        const decision = store.decideFoldedClaim({ request, folded, results, accountKey: key });
        if (decision.kind === "mismatch") throw new SharingError("idempotency.mismatch");
        if (decision.kind === "in_progress") throw new SharingError("idempotency.in_progress");
        return decision.kind === "replay" ? { replay: decision.response.body } : null;
      },
    };
    const grant = await this.grants.revoke(actor, input.artifactId, input.grantId, fold);
    return {
      grantId: grant.id,
      artifactId: grant.artifactId,
      status: grant.status,
      generation: grant.generation,
    };
  }
}
