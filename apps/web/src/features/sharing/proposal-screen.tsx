"use client";
import type { SharingProposal } from "@symplist/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { sharingApi } from "./api.ts";
import { ShareDialog } from "./share-dialog.tsx";
import { sharingFailure } from "./ui.ts";

/** A Simon proposal is only a review invitation. This trusted owner surface performs release. */
export function ShareProposalScreen({ proposalId }: { proposalId: string }) {
  const [proposal, setProposal] = useState<SharingProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void sharingApi()
      .proposal(proposalId)
      .then((value) => {
        if (live) setProposal(value);
      })
      .catch((cause) => {
        if (live) setError(sharingFailure(cause));
      });
    return () => {
      live = false;
    };
  }, [proposalId]);
  const available =
    proposal?.status === "pending" &&
    !proposal.sourceChanged &&
    proposal.proposalExpiresAt > Date.now() &&
    (proposal.expiresAt === null || proposal.expiresAt > Date.now());
  return (
    <main className="sym-handoff-screen">
      <h1>Review Simon’s share proposal</h1>
      <p>
        Nothing has been shared. Only you can release access after reviewing the exact snapshot and
        settings.
      </p>
      {error && <p role="alert">{error}</p>}
      {!proposal && !error && <p role="status">Loading proposal…</p>}
      {proposal && (
        <>
          <Link className="sym-doc-link" href={`/tasks/${proposal.taskId}/artifacts`}>
            Back to artifacts and links
          </Link>
          {!available && (
            <p role="status">
              This proposal is no longer available, or its source changed. Review the latest source
              and create a new proposal.
            </p>
          )}
          <Button disabled={!available} onClick={() => setOpen(true)}>
            Review exact snapshot
          </Button>
          {open && (
            <ShareDialog
              api={sharingApi()}
              artifactId={proposal.artifactId}
              proposal={proposal}
              onClose={() => setOpen(false)}
              onReleased={() => setProposal({ ...proposal, status: "released" })}
            />
          )}
        </>
      )}
    </main>
  );
}
