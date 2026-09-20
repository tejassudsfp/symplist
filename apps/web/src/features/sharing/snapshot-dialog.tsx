"use client";
import type { DocumentHeadResponse, SharingArtifact } from "@symplist/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { SafeMarkdown } from "@/components/markdown/safe-markdown";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { type DocumentApi, documentApi } from "@/features/documents/api";
import { createIdempotencyKey } from "@/lib/api";
import type { SharingApi } from "./api.ts";
import { sharingFailure } from "./ui.ts";

export function SnapshotDialog({
  taskId,
  api,
  onClose,
  onCreated,
  documents = documentApi(),
}: {
  taskId: string;
  api: SharingApi;
  onClose: () => void;
  onCreated: (artifact: SharingArtifact) => void;
  documents?: DocumentApi;
}) {
  const [head, setHead] = useState<DocumentHeadResponse | null>(null);
  const [title, setTitle] = useState("Document snapshot");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [whole, setWhole] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ input: string; key: string } | null>(null);
  const mounted = useRef(true);
  const id = useId();
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void documents
      .head(taskId)
      .then((result) => {
        if (active) setHead(result);
      })
      .catch((error) => {
        if (active) setError(sharingFailure(error));
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [taskId, documents]);
  async function create() {
    if (!head?.revision || busy || !title.trim() || (!whole && selected.length === 0)) return;
    setBusy(true);
    setError(null);
    const body = {
      title: title.trim(),
      revision: head.revision,
      sectionIds: whole ? [] : [...selected],
    };
    const input = JSON.stringify(body);
    if (request.current?.input !== input) request.current = { input, key: createIdempotencyKey() };
    try {
      const artifact = await api.snapshot(taskId, body, request.current.key);
      if (mounted.current) onCreated(artifact);
    } catch (error) {
      if (mounted.current) setError(sharingFailure(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="sym-share-dialog">
        <DialogTitle>Choose the snapshot</DialogTitle>
        <DialogDescription>
          A private snapshot creates no access. You will review its content and link settings
          separately.
        </DialogDescription>
        {error && <p role="alert">{error}</p>}
        {!head && !error && <p role="status">Loading the saved page…</p>}
        {head && !head.revision && (
          <p>This page has not been saved yet. Return to the page and save it first.</p>
        )}
        {head?.revision && (
          <>
            <p className="sym-sharing-meta">
              Saved revision {head.revision.slice(0, 8)}. Unsaved editor changes are not included.
            </p>
            {head.draft && (
              <p className="sym-sharing-notice">
                This page has an unsaved draft. Save it first if you want those changes included.
              </p>
            )}
            <label htmlFor={`${id}-title`}>Snapshot name</label>
            <input
              id={`${id}-title`}
              value={title}
              maxLength={160}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
            <fieldset disabled={busy} className="sym-sharing-fieldset">
              <legend>Content</legend>
              <label>
                <input
                  type="radio"
                  checked={whole}
                  name={`${id}-selection`}
                  onChange={() => setWhole(true)}
                />
                Whole saved document
              </label>
              <label>
                <input
                  type="radio"
                  checked={!whole}
                  name={`${id}-selection`}
                  onChange={() => setWhole(false)}
                />
                Selected sections only
              </label>
              {!whole &&
                head.sections.map((section) => (
                  <label key={section.sectionId}>
                    <input
                      type="checkbox"
                      checked={selected.includes(section.sectionId)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, section.sectionId]
                            : current.filter((value) => value !== section.sectionId),
                        )
                      }
                    />
                    {section.heading ?? "Introduction"}
                  </label>
                ))}
            </fieldset>
            <details>
              <summary>Review saved source</summary>
              <div className="sym-sharing-preview">
                <SafeMarkdown source={head.markdown} />
              </div>
            </details>
          </>
        )}
        <DialogActions>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !head?.revision || !title.trim() || (!whole && selected.length === 0)}
            onClick={() => void create()}
          >
            {busy ? "Capturing…" : "Create private snapshot"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
