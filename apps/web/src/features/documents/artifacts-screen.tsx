"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EmptyState, PageIllustration } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { type DocumentApi, documentApi } from "./api.ts";
import { artifactSurface } from "./artifact-surface.ts";
import { exactTime, relativeTime, shortRevision } from "./history-format.ts";
import { BackIcon } from "./icons.tsx";
import { type DocumentFailure, describeFailure } from "./messages.ts";
import { backToPageHref, documentHistoryPath } from "./routes.ts";

/**
 * Artifacts and links for one task (artifact_shares.md). This is the documents half of that surface:
 * the task's page, the version a snapshot would capture, and the way back to the page and its
 * history. The list of snapshots and grants is the sharing feature's (§13) and arrives through
 * {@link artifactSurface}; until it does, the screen says so plainly instead of offering controls
 * that would create nothing.
 *
 * Nothing here is created by opening the screen, and no token is ever shown or stored.
 */

export interface TaskArtifactsScreenProps {
  readonly taskId: string;
  /** The task page this surface was entered from; Back returns exactly there. */
  readonly from?: string | null;
  /** Test and preview seam; defaults to the app-wide client. */
  readonly api?: DocumentApi;
  readonly now?: () => number;
}

interface Source {
  readonly revision: string | null;
  readonly updatedAt: number | null;
}

export function TaskArtifactsScreen({
  taskId,
  from,
  api: provided,
  now = () => Date.now(),
}: TaskArtifactsScreenProps) {
  const apiRef = useRef<DocumentApi | null>(provided ?? null);
  if (provided && apiRef.current !== provided) apiRef.current = provided;
  if (apiRef.current === null) apiRef.current = documentApi();
  const api = apiRef.current;

  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [failure, setFailure] = useState<DocumentFailure | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const titleId = useId();
  const sourceId = useId();

  const load = useCallback(async () => {
    setPhase("loading");
    setFailure(null);
    try {
      const head = await api.head(taskId);
      setSource({ revision: head.revision, updatedAt: head.updatedAt });
      setPhase("ready");
    } catch (error) {
      setFailure(describeFailure(error));
      setPhase("failed");
    }
  }, [api, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  const surface = artifactSurface();
  const timestamp = now();

  return (
    <div className="sym-doc-artifacts" data-slot="artifacts-screen">
      <header className="sym-doc-history-header">
        <Link href={backToPageHref(taskId, from)} className="sym-doc-back">
          <BackIcon />
          Back to page
        </Link>
        <h1 id={titleId} className="sym-doc-history-title">
          Artifacts and links
        </h1>
      </header>

      <section className="sym-doc-artifacts-source" aria-labelledby={sourceId}>
        <h2 id={sourceId} className="sym-doc-subheading">
          This page
        </h2>

        {phase === "loading" ? <SkeletonLines label="Loading this page's version" /> : null}

        {phase === "failed" && failure ? (
          <InlineError
            title={failure.title}
            description={failure.description}
            onRetry={failure.retryable ? () => void load() : undefined}
          />
        ) : null}

        {phase === "ready" && source ? (
          source.revision === null ? (
            <p className="sym-doc-notice" data-slot="unsaved-source">
              This page has not been saved yet. A link always captures a saved version, so there is
              nothing to share from it so far.
            </p>
          ) : (
            <p className="sym-doc-artifacts-version" data-slot="source-version">
              {"A link would capture the version saved "}
              <time
                dateTime={new Date(source.updatedAt ?? timestamp).toISOString()}
                title={exactTime(source.updatedAt ?? timestamp)}
              >
                {relativeTime(source.updatedAt ?? timestamp, timestamp)}
              </time>
              {". Later edits never change a link that was already created."}
            </p>
          )
        ) : null}
      </section>

      <section className="sym-doc-artifacts-list" aria-label="Snapshots and links">
        {surface ? (
          surface({
            taskId,
            headRevision: source?.revision ?? null,
            updatedAt: source?.updatedAt ?? null,
          })
        ) : (
          <EmptyState
            illustration={<PageIllustration />}
            title="No links yet"
            description="Sharing a page as a read-only link isn't available in this build. Nothing has been shared, and nothing is created by opening this screen."
          />
        )}
      </section>

      <p className="sym-doc-technical">
        {source?.revision ? `This page is at revision ${shortRevision(source.revision)}. ` : ""}
        <Link className="sym-doc-link" href={documentHistoryPath(taskId, from)}>
          See this page's revisions
        </Link>
      </p>
    </div>
  );
}
