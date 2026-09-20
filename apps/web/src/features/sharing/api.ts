import {
  type HandoffRequest,
  handoffRequestSchema,
  type SharingArtifact,
  type SharingGrant,
  type SharingGrantRequest,
  type SharingList,
  type SharingListQuery,
  type SharingPreview,
  type SharingProposal,
  type SharingRelease,
  type SharingSnapshotRequest,
  sharingArtifactSchema,
  sharingGrantSchema,
  sharingListSchema,
  sharingPreviewSchema,
  sharingProposalSchema,
  sharingReleaseSchema,
} from "@symplist/contracts";
import { type ApiClient, getApiClient } from "@/lib/api";

export interface SharingApi {
  proposal(proposalId: string): Promise<SharingProposal>;
  list(taskId: string, query?: SharingListQuery): Promise<SharingList>;
  snapshot(taskId: string, input: SharingSnapshotRequest, key: string): Promise<SharingArtifact>;
  preview(artifactId: string): Promise<SharingPreview>;
  release(artifactId: string, input: SharingGrantRequest, key: string): Promise<SharingRelease>;
  revoke(artifactId: string, grantId: string, key: string): Promise<SharingGrant>;
  handoff(taskId: string, input: HandoffRequest, key: string): Promise<SharingArtifact>;
}
export function createSharingApi(client: ApiClient): SharingApi {
  return {
    proposal: (id) =>
      client.get(`/v1/share-proposals/${encodeURIComponent(id)}`, {
        schema: sharingProposalSchema,
      }),
    list: (taskId, query) =>
      client.get(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts`, {
        schema: sharingListSchema,
        ...(query ? { query } : {}),
      }),
    snapshot: (taskId, input, key) =>
      client.post(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts`, {
        body: input,
        schema: sharingArtifactSchema,
        idempotencyKey: key,
      }),
    preview: (id) =>
      client.get(`/v1/artifacts/${encodeURIComponent(id)}`, { schema: sharingPreviewSchema }),
    release: (id, input, key) =>
      client.post(`/v1/artifacts/${encodeURIComponent(id)}/grants`, {
        body: input,
        schema: sharingReleaseSchema,
        idempotencyKey: key,
      }),
    revoke: (id, grant, key) =>
      client.post(
        `/v1/artifacts/${encodeURIComponent(id)}/grants/${encodeURIComponent(grant)}/revoke`,
        { schema: sharingGrantSchema, idempotencyKey: key },
      ),
    handoff: (taskId, input, key) =>
      client.post(`/v1/tasks/${encodeURIComponent(taskId)}/handoffs`, {
        body: handoffRequestSchema.parse(input),
        schema: sharingArtifactSchema,
        idempotencyKey: key,
      }),
  };
}
let shared: SharingApi | null = null;
export function sharingApi(): SharingApi {
  shared ??= createSharingApi(getApiClient());
  return shared;
}
