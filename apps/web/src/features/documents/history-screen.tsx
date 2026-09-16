"use client";

import type {
  DocumentCompareResponse,
  DocumentHistoryEntry,
  DocumentRevisionResponse,
} from "@symplist/contracts";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SafeMarkdown } from "@/components/markdown/safe-markdown";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState, PageIllustration } from "@/components/ui/empty-state";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { useAnnouncer } from "@/components/ui/status-announcer";
import { IdempotencyKeys } from "@/lib/api";
import { type DocumentApi, documentApi } from "./api.ts";
import { CompareView } from "./compare-view.tsx";
import {
  actorLabel,
  entryDescription,
  exactTime,
  groupHistory,
  groupSummary,
  kindLabel,
  relativeTime,
  shortRevision,
} from "./history-format.ts";
import { BackIcon } from "./icons.tsx";
import { type DocumentFailure, describeFailure } from "./messages.ts";
import { backToPageHref } from "./routes.ts";

/**
 * Document revisions and conflict review (document_history.md): a compact list of revisions with who
 * made them and when, a readable preview of the one selected, a comparison with the current version
 * whose added and removed labels never depend on colour, and Restore, which publishes a new current
 * revision and keeps every earlier one. On a phone the list and the preview are sequential screens.
 */

export const HISTORY_PAGE_SIZE = 25;

type RestorePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "confirming" }
  | { readonly kind: "restoring" }
  | { readonly kind: "restored"; readonly revision: string }
  | { readonly kind: "conflict"; readonly currentRevision: string | null }
  | { readonly kind: "failed"; readonly failure: DocumentFailure };

export interface DocumentHistoryScreenProps {
  readonly taskId: string;
  /** The task page this surface was entered from; Back returns exactly there. */
  readonly from?: string | null;
  /** Test and preview seam; defaults to the app-wide client. */
  readonly api?: DocumentApi;
  /** Test seam for relative times. */
  readonly now?: () => number;
}

export function DocumentHistoryScreen({
  taskId,
  from,
  api: provided,
  now = () => Date.now(),
}: DocumentHistoryScreenProps) {
  const apiRef = useRef<DocumentApi | null>(provided ?? null);
  if (provided && apiRef.current !== provided) apiRef.current = provided;
  if (apiRef.current === null) apiRef.current = documentApi();
  const api = apiRef.current;

  const [entries, setEntries] = useState<readonly DocumentHistoryEntry[]>([]);
  const [headRevision, setHeadRevision] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listPhase, setListPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [listFailure, setListFailure] = useState<DocumentFailure | null>(null);
  const [loadingMoreList, setLoadingMoreList] = useState(false);

  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentRevisionResponse | null>(null);
  const [comparison, setComparison] = useState<DocumentCompareResponse | null>(null);
  const [detailPhase, setDetailPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [detailFailure, setDetailFailure] = useState<DocumentFailure | null>(null);
  const [loadingHunks, setLoadingHunks] = useState(false);

  const [restore, setRestore] = useState<RestorePhase>({ kind: "idle" });
  const [screen, setScreen] = useState<"list" | "detail">("list");

  const keys = useRef(new IdempotencyKeys());
  const restoreButton = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const { announce } = useAnnouncer();
  const titleId = useId();
  const listId = useId();

  const loadHistory = useCallback(
    async (nextCursor?: string) => {
      if (nextCursor) setLoadingMoreList(true);
      else {
        setListPhase("loading");
        setListFailure(null);
      }
      try {
        const page = await api.history(taskId, {
          limit: HISTORY_PAGE_SIZE,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });
        setHeadRevision(page.headRevision);
        setEntries((current) => (nextCursor ? [...current, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setListPhase("ready");
      } catch (error) {
        const failure = describeFailure(error);
        if (nextCursor) {
          // A stale cursor only means the list moved on; start again from the newest revision.
          setCursor(null);
          setListFailure(failure);
        } else {
          setListFailure(failure);
          setListPhase("failed");
        }
      } finally {
        setLoadingMoreList(false);
      }
    },
    [api, taskId],
  );

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const openRevision = useCallback(
    async (revision: string) => {
      setSelected(revision);
      setScreen("detail");
      setDetailPhase("loading");
      setDetailFailure(null);
      setPreview(null);
      setComparison(null);
      setRestore({ kind: "idle" });
      try {
        const revisionPreview = await api.revision(taskId, revision);
        setPreview(revisionPreview);
        if (!revisionPreview.isHead) {
          const compared = await api.compare(taskId, {
            base: revision,
            target: revisionPreview.headRevision,
          });
          setComparison(compared);
        }
        setDetailPhase("ready");
      } catch (error) {
        setDetailFailure(describeFailure(error));
        setDetailPhase("failed");
      }
    },
    [api, taskId],
  );

  const loadMoreHunks = useCallback(async () => {
    if (!comparison?.nextCursor || !selected) return;
    setLoadingHunks(true);
    try {
      const next = await api.compare(taskId, {
        base: comparison.baseRevision,
        target: comparison.targetRevision,
        cursor: comparison.nextCursor,
      });
      setComparison((current) =>
        current
          ? {
              ...next,
              changes: current.changes,
              hunks: [...current.hunks, ...next.hunks],
            }
          : next,
      );
    } catch (error) {
      setDetailFailure(describeFailure(error));
    } finally {
      setLoadingHunks(false);
    }
  }, [api, comparison, selected, taskId]);

  const runRestore = useCallback(async () => {
    if (!selected || !preview) return;
    setRestore({ kind: "restoring" });
    try {
      const result = await api.restore(taskId, {
        revision: selected,
        expectedRevision: preview.headRevision,
        idempotencyKey: keys.current.acquire(`restore:${selected}:${preview.headRevision}`),
      });
      keys.current.release(`restore:${selected}:${preview.headRevision}`);
      setRestore({ kind: "restored", revision: result.revision ?? selected });
      announce("Restored. The page now shows this version, and every earlier revision is kept.");
      await loadHistory();
      await openRevision(result.revision ?? selected);
    } catch (error) {
      const failure = describeFailure(error);
      keys.current.release(`restore:${selected}:${preview.headRevision}`);
      if (failure.code === "document.conflict") {
        const details = (error as { details?: { currentRevision?: unknown } }).details;
        setRestore({
          kind: "conflict",
          currentRevision:
            typeof details?.currentRevision === "string" ? details.currentRevision : null,
        });
        announce("The page changed after you previewed it. Nothing was restored.");
        return;
      }
      setRestore({ kind: "failed", failure });
    }
  }, [api, announce, loadHistory, openRevision, preview, selected, taskId]);

  const groups = groupHistory(entries);
  const timestamp = now();
  const backHref = backToPageHref(taskId, from);

  return (
    <div className="sym-doc-history" data-screen={screen} data-slot="history-screen">
      <header className="sym-doc-history-header">
        <Link href={backHref} className="sym-doc-back">
          <BackIcon />
          Back to page
        </Link>
        <h1 id={titleId} className="sym-doc-history-title">
          Document history
        </h1>
      </header>

      <div className="sym-doc-history-body">
        <section className="sym-doc-history-list" aria-labelledby={listId}>
          <h2 id={listId} className="sym-doc-subheading">
            Revisions
          </h2>

          {listPhase === "loading" ? <SkeletonLines label="Loading revisions" /> : null}

          {listPhase === "failed" && listFailure ? (
            <InlineError
              title={listFailure.title}
              description={listFailure.description}
              onRetry={listFailure.retryable ? () => void loadHistory() : undefined}
            />
          ) : null}

          {listPhase === "ready" && entries.length === 0 ? (
            <EmptyState
              illustration={<PageIllustration />}
              title="No previous versions"
              description="This page has not been saved yet. Every save from now on appears here."
            />
          ) : null}

          {listPhase === "ready" && entries.length > 0 ? (
            <>
              <ul className="sym-doc-revisions">
                {groups.map((group) => (
                  <li key={group.key} className="sym-doc-revision-group">
                    <p className="sym-doc-revision-group-header">
                      <span className="sym-doc-actor">{actorLabel(group.author)}</span>
                      <span className="sym-doc-revision-count">{groupSummary(group)}</span>
                    </p>
                    <ul>
                      {group.entries.map((entry) => {
                        const kind = kindLabel(entry.kind);
                        const isHead = entry.revision === headRevision;
                        return (
                          <li key={entry.revision}>
                            <button
                              type="button"
                              className="sym-doc-revision"
                              aria-current={entry.revision === selected ? "true" : undefined}
                              aria-label={entryDescription(entry, timestamp)}
                              onClick={() => void openRevision(entry.revision)}
                            >
                              <span className="sym-doc-revision-subject">{entry.subject}</span>
                              <span className="sym-doc-revision-meta">
                                <time
                                  dateTime={new Date(entry.committedAt).toISOString()}
                                  title={exactTime(entry.committedAt)}
                                >
                                  {relativeTime(entry.committedAt, timestamp)}
                                </time>
                                {kind ? <span className="sym-doc-badge">{kind}</span> : null}
                                {isHead ? (
                                  <span className="sym-doc-badge" data-current="true">
                                    Current
                                  </span>
                                ) : null}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
              {cursor ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={loadingMoreList}
                  aria-busy={loadingMoreList || undefined}
                  onClick={() => void loadHistory(cursor)}
                >
                  {loadingMoreList ? "Loading…" : "Show older revisions"}
                </Button>
              ) : null}
              <p className="sym-doc-technical">
                Revisions record page changes only. Chat messages stay in the task's conversation.
              </p>
            </>
          ) : null}
        </section>

        <section
          className="sym-doc-history-detail"
          aria-label="Revision preview"
          ref={detailRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === "Escape" && screen === "detail") {
              event.preventDefault();
              setScreen("list");
            }
          }}
        >
          <button
            type="button"
            className="sym-doc-detail-back"
            onClick={() => setScreen("list")}
            aria-label="Back to revisions"
          >
            <BackIcon />
            Revisions
          </button>

          {detailPhase === "idle" ? (
            <EmptyState
              title="Select a revision"
              description="Its text and what changed since then appear here."
            />
          ) : null}

          {detailPhase === "loading" ? <SkeletonLines label="Loading this revision" /> : null}

          {detailPhase === "failed" && detailFailure ? (
            <InlineError
              title={detailFailure.title}
              description={detailFailure.description}
              onRetry={
                detailFailure.retryable && selected ? () => void openRevision(selected) : undefined
              }
            />
          ) : null}

          {detailPhase === "ready" && preview ? (
            <>
              <div className="sym-doc-detail-head">
                <p className="sym-doc-detail-subject">{preview.entry.subject}</p>
                <p className="sym-doc-detail-meta">
                  <span>{actorLabel(preview.entry.author)}</span>
                  {" · "}
                  <time
                    dateTime={new Date(preview.entry.committedAt).toISOString()}
                    title={exactTime(preview.entry.committedAt)}
                  >
                    {relativeTime(preview.entry.committedAt, timestamp)}
                  </time>
                  {preview.isHead ? " · Current version" : null}
                </p>
              </div>

              {restore.kind === "restored" ? (
                <p className="sym-doc-restored" role="status" data-slot="restored">
                  Restored. The page now shows this version as revision{" "}
                  {shortRevision(restore.revision)}, and every earlier revision is kept.
                </p>
              ) : null}

              {restore.kind === "conflict" ? (
                <div className="sym-doc-notice" role="alert" data-slot="restore-conflict">
                  <p className="sym-doc-notice-title">The page changed after you previewed it</p>
                  <p>
                    Nothing was restored and no newer edit was discarded. Look at the latest
                    version, then restore again if you still want to.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRestore({ kind: "idle" });
                      void loadHistory();
                      if (selected) void openRevision(selected);
                    }}
                  >
                    Reload and preview again
                  </Button>
                </div>
              ) : null}

              {restore.kind === "failed" ? (
                <InlineError
                  title={restore.failure.title}
                  description={restore.failure.description}
                  onRetry={
                    restore.failure.retryable
                      ? () => {
                          setRestore({ kind: "idle" });
                        }
                      : undefined
                  }
                />
              ) : null}

              {preview.isHead ? (
                <p className="sym-doc-notice">This is the version the page shows now.</p>
              ) : (
                <Button
                  ref={restoreButton}
                  variant="secondary"
                  disabled={restore.kind === "restoring"}
                  aria-busy={restore.kind === "restoring" || undefined}
                  onClick={() => setRestore({ kind: "confirming" })}
                >
                  {restore.kind === "restoring" ? "Restoring…" : "Restore this version"}
                </Button>
              )}

              {comparison ? (
                <CompareView
                  comparison={comparison}
                  loadingMore={loadingHunks}
                  {...(comparison.nextCursor ? { onLoadMore: () => void loadMoreHunks() } : {})}
                />
              ) : null}

              <h3 className="sym-doc-subheading">This version</h3>
              <div className="sym-markdown sym-doc-preview" data-slot="revision-preview">
                <SafeMarkdown source={preview.markdown} headingLevelStart={4} />
              </div>
              <p className="sym-doc-technical">{`Revision ${shortRevision(preview.entry.revision)}`}</p>
            </>
          ) : null}
        </section>
      </div>

      <ConfirmDialog
        open={restore.kind === "confirming"}
        onOpenChange={(open) => {
          if (!open && restore.kind === "confirming") setRestore({ kind: "idle" });
        }}
        title="Restore this version?"
        description="This adds a new current revision with this version's text. Nothing is deleted: every revision, including the one on the page now, stays in this list."
        confirmLabel="Restore"
        initialFocus="cancel"
        finalFocus={restoreButton}
        busy={restore.kind === "restoring"}
        onConfirm={() => void runRestore()}
      />
    </div>
  );
}
