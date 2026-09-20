"use client";
import type {
  DocumentHeadResponse,
  HandoffRequest,
  SharingArtifact,
  SharingRelease,
} from "@symplist/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useNavigationGuard } from "@/features/access/ui/navigation-guard";
import { type DocumentApi, documentApi } from "@/features/documents/api";
import { createIdempotencyKey } from "@/lib/api";
import { type SharingApi, sharingApi } from "./api.ts";
import { registerHandoff } from "./controller.ts";
import {
  handoffDraftFailure,
  handoffDraftHandler,
  subscribeHandoffDraftHandler,
} from "./handoff-draft.ts";
import { ShareDialog } from "./share-dialog.tsx";
import { SnapshotDialog } from "./snapshot-dialog.tsx";
import { copySharingText, downloadSharingText, expiryLabel, sharingFailure } from "./ui.ts";

export { type HandoffDraftHandler, setHandoffDraftHandler } from "./handoff-draft.ts";

export function manualHandoffPrompt(outcome: string): string {
  return `## Objective\n${outcome.trim() || "Describe the result you need."}\n\n## Instructions\nUse the supplied artifact as source context. Distinguish facts from assumptions. Ask about unresolved requirements before making irreversible choices.\n\n## Constraints\nList the scope, limitations and relevant deadline here. Do not invent missing task properties.\n\n## Expected output\nDescribe the deliverable and the checks it should pass.\n\n## Acceptance checks\n- Address the stated objective.\n- Explain assumptions and remaining questions.\n\n## Open questions\nList anything the source does not answer.\n\n## Return instructions\nReturn the result to me to review and paste into Symplist. Shared links are read-only and do not authorize edits or connector use.\n`;
}

export function HandoffScreen({
  taskId,
  api: injected,
  documents: injectedDocuments,
}: {
  taskId: string;
  api?: SharingApi;
  documents?: DocumentApi;
}) {
  const api = useRef(injected ?? sharingApi()).current;
  const documents = useRef(injectedDocuments ?? documentApi()).current;
  const draftHandler = useSyncExternalStore(
    subscribeHandoffDraftHandler,
    handoffDraftHandler,
    handoffDraftHandler,
  );
  const [head, setHead] = useState<DocumentHeadResponse | null>(null);
  const [artifacts, setArtifacts] = useState<readonly SharingArtifact[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [target, setTarget] = useState<HandoffRequest["target"]>("coding_assistant");
  const [outcome, setOutcome] = useState("");
  const [prompt, setPrompt] = useState(manualHandoffPrompt(""));
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const [capture, setCapture] = useState(false);
  const [replaceDraft, setReplaceDraft] = useState<"manual" | "simon" | null>(null);
  const [links, setLinks] = useState<Readonly<Record<string, SharingRelease>>>({});
  const [savedPrompt, setSavedPrompt] = useState(prompt);
  const [savedSelection, setSavedSelection] = useState("[]");
  const guard = useNavigationGuard(
    prompt !== savedPrompt || JSON.stringify(selected) !== savedSelection,
    {
      title: "Leave this handoff draft?",
      description:
        "Your unsaved prompt changes and one-time links will be lost. Save the private prompt and copy any links you need first.",
      confirmLabel: "Leave draft",
      cancelLabel: "Keep editing",
    },
  );
  const request = useRef<{ input: string; key: string } | null>(null);
  const draftAbort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void Promise.all([documents.head(taskId), api.list(taskId)])
      .then(([source, list]) => {
        if (alive.current) {
          setHead(source);
          setArtifacts(list.artifacts);
          const current = list.artifacts.find(
            (item) => item.kind === "document" && item.sourceRevision === source.revision,
          );
          const initialSelection = current ? [current.id] : [];
          setSelected(initialSelection);
          setSavedSelection(JSON.stringify(initialSelection));
        }
      })
      .catch((error) => {
        if (alive.current) setError(sharingFailure(error));
      });
    return () => {
      alive.current = false;
      draftAbort.current?.abort();
      draftAbort.current = null;
    };
  }, [api, documents, taskId]);
  const assembled = useCallback(() => {
    return `${prompt}\n\n## Supplied artifacts\n${selected
      .map((id) => {
        const artifact = artifacts.find((item) => item.id === id);
        const released = links[id];
        if (
          !released ||
          released.secretUnavailable ||
          (released.grant.expiresAt !== null && released.grant.expiresAt <= Date.now())
        )
          return `- ${artifact?.title ?? "Artifact"}: {{artifact:${id}}} — release a current link or supply a downloaded copy`;
        return `- ${artifact?.title ?? "Artifact"}: ${released.url} (expires ${expiryLabel(released.grant.expiresAt)}, ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
      })
      .join(
        "\n",
      )}\n\nIf a link expires or cannot be fetched, ask for a fresh link or a pasted/downloaded copy. A shared link never grants write access.\n`;
  }, [prompt, selected, artifacts, links]);
  const copyPrompt = useCallback(async () => {
    const copied = await copySharingText(assembled());
    if (alive.current)
      setStatus(
        copied
          ? "Prepared prompt copied. Nothing was sent to another service."
          : "Copy failed. Select the editable prompt and copy it manually.",
      );
  }, [assembled]);
  useEffect(
    () => registerHandoff({ canCopy: Boolean(prompt.trim()), copy: () => void copyPrompt() }),
    [copyPrompt, prompt],
  );
  async function save() {
    if (!head?.revision || busy) return;
    setBusy(true);
    setError(null);
    const body: HandoffRequest = {
      title: "Handoff prompt",
      revision: head.revision,
      target,
      prompt,
      artifactIds: [...selected],
    };
    const input = JSON.stringify(body);
    if (request.current?.input !== input) request.current = { input, key: createIdempotencyKey() };
    try {
      await api.handoff(taskId, body, request.current.key);
      if (alive.current) {
        setStatus("Private prompt snapshot saved. No link was created and nothing was sent.");
        request.current = null;
        setSavedPrompt(prompt);
        setSavedSelection(JSON.stringify(selected));
      }
    } catch (error) {
      if (alive.current) setError(sharingFailure(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function generate() {
    if (!head?.revision || !draftHandler || busy) return;
    draftAbort.current?.abort();
    const controller = new AbortController();
    draftAbort.current = controller;
    setBusy(true);
    setError(null);
    setStatus("Simon is reading the selected task context and drafting…");
    try {
      const draft = await draftHandler({
        taskId,
        revision: head.revision,
        target,
        outcome: outcome.trim(),
        artifactIds: selected,
        signal: controller.signal,
      });
      if (alive.current && draftAbort.current === controller) {
        setPrompt(draft);
        setStatus("Draft ready. Review facts, assumptions and the exact context before sharing.");
      }
    } catch (error) {
      const drafting = handoffDraftFailure(error);
      const message = drafting === null ? sharingFailure(error) : drafting;
      if (alive.current && draftAbort.current === controller && message) {
        setStatus(null);
        setError(message);
      }
    } finally {
      if (alive.current && draftAbort.current === controller) {
        draftAbort.current = null;
        setBusy(false);
      }
    }
  }
  function startDraft(kind: "manual" | "simon") {
    if (kind === "simon") {
      void generate();
      return;
    }
    setPrompt(manualHandoffPrompt(outcome));
    setStatus("Manual template ready. Review and fill in the details.");
  }
  function requestDraft(kind: "manual" | "simon") {
    if (prompt !== manualHandoffPrompt("")) setReplaceDraft(kind);
    else startDraft(kind);
  }
  return (
    <main className="sym-handoff-screen">
      <Link className="sym-doc-link" href={`/tasks/${taskId}/artifacts`}>
        Back to artifacts and links
      </Link>
      <h1>Prepare handoff</h1>
      <p>
        Prepare useful instructions for another tool. Destination names describe the prompt style,
        not live integrations. Nothing is sent automatically.
      </p>
      {error && (
        <p role="alert" className="sym-sharing-error">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="sym-sharing-notice">
          {status}
        </p>
      )}
      {!head && !error && <p role="status">Loading task context…</p>}
      {head && !head.revision && (
        <p>Save the task page first so the handoff can name a reviewed revision.</p>
      )}
      <label htmlFor="handoff-target">Destination</label>
      <select
        id="handoff-target"
        value={target}
        disabled={busy}
        onChange={(event) => setTarget(event.target.value as HandoffRequest["target"])}
      >
        <option value="coding_assistant">A coding assistant</option>
        <option value="general_assistant">A general-purpose assistant</option>
        <option value="other">Other</option>
      </select>
      <label htmlFor="handoff-outcome">Desired outcome</label>
      <input
        id="handoff-outcome"
        value={outcome}
        maxLength={500}
        disabled={busy}
        onChange={(event) => setOutcome(event.target.value)}
        placeholder="What should come back?"
      />
      <div className="sym-sharing-buttons">
        <Button variant="secondary" disabled={busy} onClick={() => requestDraft("manual")}>
          Start a manual draft
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !head?.revision || !draftHandler || !outcome.trim()}
          onClick={() => requestDraft("simon")}
        >
          Ask Simon to draft
        </Button>
      </div>
      {!draftHandler && (
        <p className="sym-sharing-meta">
          You can write a handoff manually here. Simon drafting is not connected in this build.
        </p>
      )}
      <fieldset className="sym-sharing-fieldset" disabled={busy}>
        <legend>Context inventory</legend>
        <p>
          Choose only the snapshots needed for this outcome. Selecting one does not create access.
        </p>
        <Button variant="secondary" disabled={!head?.revision} onClick={() => setCapture(true)}>
          Capture current page or sections
        </Button>
        {artifacts.length === 0 && (
          <p>
            No private snapshots yet.{" "}
            <Link className="sym-doc-link" href={`/tasks/${taskId}/artifacts`}>
              Capture the saved page or selected sections
            </Link>
            .
          </p>
        )}
        {artifacts.map((artifact) => (
          <div key={artifact.id} className="sym-handoff-artifact">
            <label>
              <input
                type="checkbox"
                checked={selected.includes(artifact.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, artifact.id]
                      : current.filter((id) => id !== artifact.id),
                  )
                }
              />
              {artifact.title} · {artifact.sourceRevision.slice(0, 8)}
            </label>
            {selected.includes(artifact.id) && (
              <Button variant="ghost" onClick={() => setReview(artifact.id)}>
                Review and create link
              </Button>
            )}
          </div>
        ))}
      </fieldset>
      <label htmlFor="handoff-prompt">Editable prompt</label>
      <textarea
        id="handoff-prompt"
        value={prompt}
        maxLength={32000}
        rows={18}
        disabled={busy}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <p className="sym-sharing-meta">
        Saved prompts keep artifact placeholders, never live URLs. Copy/download below assembles
        newly released links only in this browser and may contain access capabilities. Share
        passwords separately.
      </p>
      <div className="sym-sharing-buttons">
        <Button disabled={busy || !head?.revision || !prompt.trim()} onClick={() => void save()}>
          {busy ? "Working…" : "Save private prompt"}
        </Button>
        <Button variant="secondary" disabled={!prompt.trim()} onClick={() => void copyPrompt()}>
          Copy prepared prompt
        </Button>
        <Button
          variant="secondary"
          disabled={!prompt.trim()}
          onClick={() => downloadSharingText(assembled(), "handoff.md")}
        >
          Download Markdown
        </Button>
      </div>
      {review && (
        <ShareDialog
          key={review}
          artifactId={review}
          api={api}
          onClose={() => setReview(null)}
          onReleased={(released) => setLinks((current) => ({ ...current, [review]: released }))}
        />
      )}
      {capture && (
        <SnapshotDialog
          taskId={taskId}
          api={api}
          documents={documents}
          onClose={() => setCapture(false)}
          onCreated={(artifact) => {
            setArtifacts((current) => [artifact, ...current]);
            setSelected([artifact.id]);
            setCapture(false);
          }}
        />
      )}
      {guard.dialog}
      <ConfirmDialog
        open={replaceDraft !== null}
        onOpenChange={(open) => {
          if (!open) setReplaceDraft(null);
        }}
        title="Replace this prompt?"
        description="Starting a new draft replaces the prompt in this editor. Save or copy your current text first if you need to keep it."
        confirmLabel="Replace prompt"
        onConfirm={() => {
          if (replaceDraft) startDraft(replaceDraft);
          setReplaceDraft(null);
        }}
      />
    </main>
  );
}
