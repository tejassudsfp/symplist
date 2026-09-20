"use client";

import type { DocumentCompareResponse } from "@symplist/contracts";
import { Button } from "@/components/ui/button";
import {
  changeStatusLabel,
  changeSummary,
  diffLineLabel,
  sectionLabel,
  shortRevision,
} from "./history-format.ts";

/**
 * The comparison between a chosen revision and the current one (document_history brief). Added and
 * removed never rely on colour: every changed section carries a word, and every diff line carries a
 * `+` or `−` marker and a screen-reader label. There is no repository browser here — no branches, no
 * staging, no pull requests — only what changed and where.
 */

export interface CompareViewProps {
  readonly comparison: DocumentCompareResponse;
  /** Loads the next page of hunks; absent when there is nothing more. */
  readonly onLoadMore?: () => void;
  readonly loadingMore?: boolean;
}

export function CompareView({ comparison, onLoadMore, loadingMore = false }: CompareViewProps) {
  return (
    <div className="sym-doc-compare" data-slot="compare-view">
      <p className="sym-doc-compare-summary">
        {changeSummary(comparison.changes)}
        {comparison.commitsBetween > 0 ? (
          <span className="sym-doc-compare-between">
            {comparison.commitsBetween === 1
              ? " · 1 revision in between"
              : ` · ${comparison.commitsBetween} revisions in between`}
          </span>
        ) : null}
      </p>

      {comparison.changes.length === 0 ? (
        <p className="sym-doc-notice" data-slot="no-net-change">
          This revision and the current version hold the same text. Revisions in between are still
          listed on the left.
        </p>
      ) : (
        <ul className="sym-doc-change-list">
          {comparison.changes.map((change) => (
            <li
              key={`${change.status}:${change.sectionId ?? change.baselineSectionId ?? sectionLabel(change)}`}
              className="sym-doc-change"
            >
              <span className="sym-doc-badge" data-status={change.status}>
                {changeStatusLabel(change.status)}
              </span>
              <span className="sym-doc-change-name">{sectionLabel(change)}</span>
            </li>
          ))}
        </ul>
      )}

      {comparison.hunks.length > 0 ? (
        <div className="sym-doc-hunks">
          <h3 className="sym-doc-subheading">Line by line</h3>
          {comparison.hunks.map((hunk) => (
            <div
              key={`${hunk.baseStart}-${hunk.targetStart}-${hunk.baseLines}-${hunk.targetLines}`}
              className="sym-doc-hunk"
            >
              <p className="sym-doc-hunk-range">
                {`Lines ${hunk.baseStart}–${hunk.baseStart + Math.max(0, hunk.baseLines - 1)} in the chosen revision, ${hunk.targetStart}–${hunk.targetStart + Math.max(0, hunk.targetLines - 1)} now`}
              </p>
              <ol className="sym-doc-diff">
                {hunk.lines.map((line, index) => {
                  const label = diffLineLabel(line.kind);
                  return (
                    <li
                      // Diff lines are positional and never reorder.
                      // biome-ignore lint/suspicious/noArrayIndexKey: the index is the line's identity in its hunk.
                      key={index}
                      className="sym-doc-diff-line"
                      data-kind={line.kind}
                    >
                      <span className="sym-doc-diff-marker" aria-hidden="true">
                        {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                      </span>
                      {label ? <span className="sr-only">{`${label}: `}</span> : null}
                      <code className="sym-doc-diff-text">
                        {line.text === "" ? " " : line.text}
                      </code>
                    </li>
                  );
                })}
              </ol>
              {hunk.truncated ? (
                <p className="sym-doc-hunk-note">
                  This block was shortened to keep the page quick.
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {onLoadMore ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onLoadMore}
          disabled={loadingMore}
          aria-busy={loadingMore || undefined}
        >
          {loadingMore ? "Loading…" : "Show more differences"}
        </Button>
      ) : null}

      <p className="sym-doc-technical">
        {`Revision ${shortRevision(comparison.baseRevision)} compared with ${shortRevision(comparison.targetRevision)}`}
      </p>
    </div>
  );
}
