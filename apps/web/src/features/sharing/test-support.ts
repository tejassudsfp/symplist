import type { SharingArtifact, SharingGrant, SharingRelease } from "@symplist/contracts";
import { vi } from "vitest";
import type { SharingApi } from "./api.ts";

export const artifact: SharingArtifact = {
  id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b81",
  taskId: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b82",
  title: "Launch brief",
  sourceRevision: "a".repeat(40),
  currentHead: "a".repeat(40),
  sectionIds: [],
  bytes: 100,
  createdAt: 1_800_000_000_000,
  kind: "document",
};
export const grant: SharingGrant = {
  id: "01929f3e-7c1a-7b2e-9a55-3c2f1d0e9b83",
  artifactId: artifact.id,
  mode: "link",
  status: "active",
  disabledReason: null,
  expiresAt: Date.now() + 86400000,
  createdAt: Date.now(),
  generation: 1,
};
export const release: SharingRelease = {
  grant,
  url: `https://share.example/artifact/${artifact.id}?key=${"x".repeat(43)}`,
  secretUnavailable: false,
};
export function fakeSharingApi(overrides: Partial<SharingApi> = {}): SharingApi {
  return {
    list: vi.fn(async () => ({
      artifacts: [artifact],
      grants: [],
      hasMore: false,
      nextArtifact: null,
      nextGrant: null,
    })),
    preview: vi.fn(async () => ({
      artifact,
      markdown: "# Snapshot content\nReviewed content\n",
      hasPublicCopy: false,
    })),
    snapshot: vi.fn(async () => artifact),
    release: vi.fn(async () => release),
    revoke: vi.fn(async () => ({ ...grant, status: "revoked" as const })),
    handoff: vi.fn(async () => ({ ...artifact, kind: "handoff" as const })),
    proposal: vi.fn(async () => ({
      id: grant.id,
      artifactId: artifact.id,
      taskId: artifact.taskId,
      expectedHead: artifact.sourceRevision,
      mode: "link" as const,
      expiresAt: grant.expiresAt,
      proposalExpiresAt: Date.now() + 86400000,
      status: "pending" as const,
      sourceChanged: false,
    })),
    ...overrides,
  };
}
