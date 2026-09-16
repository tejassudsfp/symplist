"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { InlineError } from "@/components/ui/inline-error";
import { SkeletonLines } from "@/components/ui/skeleton";
import { useAnnouncer } from "@/components/ui/status-announcer";
import type { DocumentApi } from "./api.ts";
import {
  applyMerge,
  defaultChoices,
  type MergeChoice,
  type MergePlan,
  mergeStatusLabel,
  planMerge,
} from "./merge.ts";
import { type DocumentFailure, describeFailure } from "./messages.ts";
import type { ConflictState } from "./use-document.ts";

/**
 * Conflict review (document_history.md, note 11): "This section changed while you were editing",
 * with this device's draft and the saved version side by side, an explicit choice for every section
 * the two sides genuinely disagree about, and no claim that anything was overwritten. Sections only
 * one side touched are shown as such and kept; nothing is discarded without being asked.
 */

export interface ConflictReviewProps {
  readonly taskId: string;
  readonly api: DocumentApi;
  readonly conflict: ConflictState;
  /** This device's unsaved text, which is fresher than the stored draft. */
  readonly draftMarkdown: string;
  readonly onApply: (markdown: string) => Promise<void>;
  readonly onKeepDraft: () => void;
  readonly onDiscardDraft: () => Promise<void>;
}

interface Loaded {
  readonly plan: MergePlan;
  readonly savedMarkdown: string;
  readonly truncated: boolean;
  readonly currentRevision: string | null;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const { announce } = useAnnouncer();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        const clipboard = globalThis.navigator?.clipboard;
        if (!clipboard) {
          announce("Copying isn't available in this browser");
          return;
        }
        void clipboard.writeText(text).then(
          () => {
            setCopied(true);
            announce(`${label} copied`);
            globalThis.setTimeout(() => setCopied(false), 2000);
          },
          () => announce("The text couldn't be copied"),
        );
      }}
    >
      {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
    </Button>
  );
}

export function ConflictReview({
  taskId,
  api,
  conflict,
  draftMarkdown,
  onApply,
  onKeepDraft,
  onDiscardDraft,
}: ConflictReviewProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<DocumentFailure | null>(null);
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleId = useId();
  const discardRef = useRef<HTMLButtonElement>(null);
  const draftRef = useRef(draftMarkdown);
  draftRef.current = draftMarkdown;

  const load = useCallback(async () => {
    setFailure(null);
    setLoaded(null);
    try {
      const review = await api.conflict(taskId, conflict.baseRevision);
      const base = conflict.baseRevision
        ? (await api.revision(taskId, conflict.baseRevision)).markdown
        : "";
      const plan = planMerge(base, review.savedMarkdown, draftRef.current);
      setLoaded({
        plan,
        savedMarkdown: review.savedMarkdown,
        truncated: review.truncated,
        currentRevision: review.currentRevision,
      });
      setChoices(defaultChoices(plan));
    } catch (error) {
      const described = describeFailure(error);
      if (described.code === "document.resync_required" || described.code === "not_found") {
        // The revision the draft started from is gone, so only a whole-document choice is honest.
        try {
          const review = await api.conflict(taskId, null);
          const plan = planMerge("", review.savedMarkdown, draftRef.current);
          setLoaded({
            plan,
            savedMarkdown: review.savedMarkdown,
            truncated: review.truncated,
            currentRevision: review.currentRevision,
          });
          setChoices(defaultChoices(plan));
          return;
        } catch (fallbackError) {
          setFailure(describeFailure(fallbackError));
          return;
        }
      }
      setFailure(described);
    }
  }, [api, taskId, conflict.baseRevision]);

  useEffect(() => {
    void load();
  }, [load]);

  const decisions = useMemo(() => loaded?.plan.conflicts ?? [], [loaded]);
  const kept = useMemo(
    () =>
      (loaded?.plan.entries ?? []).filter(
        (entry) => !entry.needsChoice && entry.status !== "unchanged",
      ),
    [loaded],
  );

  return (
    <section className="sym-doc-conflict" aria-labelledby={titleId} data-slot="conflict-review">
      <h2 id={titleId} className="sym-doc-conflict-title">
        This page changed while you were editing
      </h2>
      <p className="sym-doc-conflict-lead">
        Nothing you wrote was overwritten: your draft is still here. Choose what the next revision
        should contain.
      </p>

      {failure ? (
        <InlineError
          title={failure.title}
          description={failure.description}
          onRetry={failure.retryable ? () => void load() : undefined}
        />
      ) : null}

      {!loaded && !failure ? <SkeletonLines label="Loading the saved version" /> : null}

      {loaded ? (
        <>
          {loaded.plan.wholeDocument ? (
            <p className="sym-doc-conflict-note">
              This page is too large to compare section by section. Choose the whole draft or the
              whole saved page.
            </p>
          ) : null}
          {loaded.truncated ? (
            <p className="sym-doc-conflict-note">
              Some sections were too long to show in full. Their text is unchanged either way.
            </p>
          ) : null}

          {decisions.length === 0 ? (
            <p className="sym-doc-conflict-note" data-slot="no-overlap">
              You and the saved page changed different sections, so nothing has to be chosen. Apply
              to save both sets of changes as a new revision.
            </p>
          ) : (
            <ul className="sym-doc-conflict-list">
              {decisions.map((entry) => {
                const choice = choices[entry.key] ?? entry.defaultChoice;
                return (
                  <li key={entry.key} className="sym-doc-conflict-item">
                    <div className="sym-doc-conflict-heading">
                      <span className="sym-doc-conflict-section">
                        {entry.heading ?? "The start of the page"}
                      </span>
                      <span className="sym-doc-badge" data-status={entry.status}>
                        {mergeStatusLabel(entry.status)}
                      </span>
                    </div>
                    <div className="sym-doc-conflict-columns">
                      <div className="sym-doc-conflict-column">
                        <p className="sym-doc-conflict-column-title">Your draft</p>
                        <pre className="sym-doc-conflict-text">
                          {entry.draftText ?? "(deleted in your draft)"}
                        </pre>
                        {entry.draftText ? (
                          <CopyButton text={entry.draftText} label="draft" />
                        ) : null}
                      </div>
                      <div className="sym-doc-conflict-column">
                        <p className="sym-doc-conflict-column-title">Saved version</p>
                        <pre className="sym-doc-conflict-text">
                          {entry.savedText ?? "(deleted on the page)"}
                        </pre>
                        {entry.savedText ? (
                          <CopyButton text={entry.savedText} label="saved version" />
                        ) : null}
                      </div>
                    </div>
                    <fieldset className="sym-doc-conflict-choice">
                      <legend className="sr-only">
                        {`Choose the version of ${entry.heading ?? "the start of the page"}`}
                      </legend>
                      <label>
                        <input
                          type="radio"
                          name={`choice-${entry.key}`}
                          checked={choice === "draft"}
                          onChange={() =>
                            setChoices((current) => ({ ...current, [entry.key]: "draft" }))
                          }
                        />
                        Keep my draft
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`choice-${entry.key}`}
                          checked={choice === "saved"}
                          onChange={() =>
                            setChoices((current) => ({ ...current, [entry.key]: "saved" }))
                          }
                        />
                        Use the saved version
                      </label>
                    </fieldset>
                  </li>
                );
              })}
            </ul>
          )}

          {kept.length > 0 ? (
            <details className="sym-doc-conflict-kept">
              <summary>{`${kept.length} other ${kept.length === 1 ? "section is" : "sections are"} kept as they are`}</summary>
              <ul>
                {kept.map((entry) => (
                  <li key={entry.key}>
                    <span className="sym-doc-badge" data-status={entry.status}>
                      {mergeStatusLabel(entry.status)}
                    </span>{" "}
                    {entry.heading ?? "The start of the page"}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <div className="sym-doc-conflict-actions">
            <Button
              variant="primary"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => {
                setBusy(true);
                void onApply(applyMerge(loaded.plan, choices)).finally(() => setBusy(false));
              }}
            >
              {busy ? "Saving…" : "Apply and save"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={onKeepDraft}>
              Keep editing
            </Button>
            <Button
              ref={discardRef}
              variant="danger"
              disabled={busy}
              onClick={() => setConfirmDiscard(true)}
            >
              Discard my draft
            </Button>
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard your draft?"
        description="The saved page replaces what you wrote on this device. This cannot be undone."
        confirmLabel="Discard draft"
        initialFocus="cancel"
        finalFocus={discardRef}
        busy={busy}
        onConfirm={() => {
          setBusy(true);
          void onDiscardDraft().finally(() => {
            setBusy(false);
            setConfirmDiscard(false);
          });
        }}
      />
    </section>
  );
}
