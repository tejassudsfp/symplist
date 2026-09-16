"use client";

import type { ReactNode } from "react";

/**
 * "Artifacts and links" is a documents surface with a sharing body (artifact_shares.md). The
 * documents feature owns the frame — the task's page, its current version, and the way back — while
 * snapshots and grants belong to the sharing feature (§13), which is a later wave.
 *
 * So the list is a seam, registered the same way Simon registers its outline handler
 * (`outline-request.ts`). Until sharing registers one the surface says plainly that no link can be
 * created yet, rather than showing controls that would do nothing.
 */

export interface ArtifactSurfaceContext {
  readonly taskId: string;
  /** The page's current published revision, or null when nothing has been published yet. */
  readonly headRevision: string | null;
  /** When that revision was published. */
  readonly updatedAt: number | null;
}

/** Renders the task's snapshots and share grants inside the documents frame. */
export type ArtifactSurfaceRenderer = (context: ArtifactSurfaceContext) => ReactNode;

let renderer: ArtifactSurfaceRenderer | null = null;

/** Registered by the sharing feature; pass null to remove it. */
export function setArtifactSurface(next: ArtifactSurfaceRenderer | null): void {
  renderer = next;
}

export function artifactSurface(): ArtifactSurfaceRenderer | null {
  return renderer;
}
