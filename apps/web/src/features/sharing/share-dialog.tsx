"use client";
import type {
  SharingGrant,
  SharingGrantRequest,
  SharingPreview,
  SharingProposal,
  SharingRelease,
} from "@symplist/contracts";
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
import { createIdempotencyKey } from "@/lib/api";
import type { SharingApi } from "./api.ts";
import { copySharingText, expiryLabel, sharingFailure } from "./ui.ts";

export interface ShareDialogProps {
  readonly artifactId: string;
  readonly api: SharingApi;
  readonly replace?: SharingGrant;
  readonly proposal?: SharingProposal;
  readonly onClose: () => void;
  readonly onReleased: (release: SharingRelease) => void;
}
export function ShareDialog({
  artifactId,
  api,
  replace,
  proposal,
  onClose,
  onReleased,
}: ShareDialogProps) {
  const [preview, setPreview] = useState<SharingPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SharingGrantRequest["mode"]>(
    proposal?.mode ?? replace?.mode ?? "link",
  );
  const [duration, setDuration] = useState("24");
  const [password, setPassword] = useState("");
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [revokeReplaced, setRevokeReplaced] = useState(Boolean(replace));
  const [busy, setBusy] = useState(false);
  const [released, setReleased] = useState<SharingRelease | null>(null);
  const [copyState, setCopyState] = useState<string | null>(null);
  const intent = useRef<{ fingerprint: string; key: string; expiresAt: number | null } | null>(
    null,
  );
  const mounted = useRef(true);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    let live = true;
    void api
      .preview(artifactId)
      .then((result) => {
        if (live) setPreview(result);
      })
      .catch((error) => {
        if (live) setError(sharingFailure(error));
      });
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [api, artifactId]);

  async function release() {
    if (
      !preview?.artifact.currentHead ||
      busy ||
      (proposal &&
        (proposal.status !== "pending" ||
          proposal.sourceChanged ||
          proposal.proposalExpiresAt <= Date.now()))
    )
      return;
    setError(null);
    setBusy(true);
    const fingerprint = JSON.stringify({
      mode,
      duration,
      password,
      publicConfirmed,
      revokeReplaced,
      head: preview.artifact.currentHead,
    });
    if (!intent.current || intent.current.fingerprint !== fingerprint)
      intent.current = {
        fingerprint,
        key: createIdempotencyKey(),
        expiresAt: proposal
          ? proposal.expiresAt
          : mode === "public" && duration === "none"
            ? null
            : Date.now() + Number(duration === "none" ? "24" : duration) * 3_600_000,
      };
    try {
      const result = await api.release(
        artifactId,
        {
          mode,
          expiresAt: intent.current.expiresAt,
          expectedHead: preview.artifact.currentHead,
          ...(mode === "password" ? { password } : {}),
          publicConfirmed,
          ...(replace ? { replaceGrantId: replace.id } : {}),
          revokeReplaced,
          ...(proposal ? { proposalId: proposal.id } : {}),
        },
        intent.current.key,
      );
      if (!mounted.current) return;
      setReleased(result);
      setPassword("");
      intent.current = null;
      onReleased(result);
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
        <DialogTitle>
          {released
            ? "Your read-only link"
            : replace
              ? "Review replacement link"
              : "Share this snapshot"}
        </DialogTitle>
        <DialogDescription>
          Later edits never change this snapshot. A link can be revoked, but copies already fetched
          cannot be recalled.
        </DialogDescription>
        {error && (
          <p role="alert" className="sym-sharing-error">
            {error}
          </p>
        )}
        {!preview && !error && <p role="status">Loading the exact snapshot…</p>}
        {preview && !released && (
          <>
            <h3>{preview.artifact.title}</h3>
            <p className="sym-sharing-meta">
              Revision {preview.artifact.sourceRevision.slice(0, 8)} ·{" "}
              {preview.artifact.sectionIds.length
                ? `${preview.artifact.sectionIds.length} selected sections`
                : "Whole saved document"}
            </p>
            {preview.artifact.sourceRevision !== preview.artifact.currentHead && (
              <p className="sym-sharing-notice">
                The private page has a newer version. This link will still contain the older
                snapshot shown below.
              </p>
            )}
            {preview.hasPublicCopy && (
              <p role="status" className="sym-sharing-notice">
                This snapshot already has an active public copy. Adding a password here does not
                make that copy private.
              </p>
            )}
            <details>
              <summary>Preview exactly what will be shared</summary>
              <div className="sym-sharing-preview">
                <SafeMarkdown source={preview.markdown} />
              </div>
            </details>
            {proposal && (
              <p className="sym-sharing-notice">
                Simon proposed these exact access settings. Review the snapshot before releasing.
                Proposed expiry: {expiryLabel(proposal.expiresAt)}.
              </p>
            )}
            <fieldset disabled={busy || Boolean(proposal)} className="sym-sharing-fieldset">
              <legend>Who can read it?</legend>
              {(
                [
                  ["link", "Anyone with the link"],
                  ["password", "Link and password"],
                  ["public", "Public artifact"],
                ] as const
              ).map(([value, label]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`${id}-mode`}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <label htmlFor={`${id}-expiry`}>Expires</label>
            <select
              id={`${id}-expiry`}
              disabled={busy || Boolean(proposal)}
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            >
              <option value="1">In 1 hour</option>
              <option value="24">In 24 hours</option>
              <option value="168">In 7 days</option>
              {mode === "public" && <option value="none">Until revoked</option>}
            </select>
            <p className="sym-sharing-meta">
              Times are shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}. Maximum seven
              days for private links.
            </p>
            {mode === "password" && (
              <>
                <label htmlFor={`${id}-password`}>Share password (at least 8 characters)</label>
                <input
                  id={`${id}-password`}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  minLength={8}
                  maxLength={256}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <p className="sym-sharing-notice">
                  Some agents cannot open password-protected links. Share the password separately,
                  or offer a download/pasted copy. The password is never sent to Simon.
                </p>
              </>
            )}
            {mode === "public" && (
              <label>
                <input
                  type="checkbox"
                  checked={publicConfirmed}
                  disabled={busy}
                  onChange={(event) => setPublicConfirmed(event.target.checked)}
                />
                I understand anyone can read this public artifact.
              </label>
            )}
            {replace && (
              <label>
                <input
                  type="checkbox"
                  checked={revokeReplaced}
                  disabled={busy}
                  onChange={(event) => setRevokeReplaced(event.target.checked)}
                />
                Revoke the previous link after creating its replacement
              </label>
            )}
            <p className="sym-sharing-meta">
              Review for sensitive details. Automated filtering cannot find every secret. Only the
              selected Markdown is shared, never chat, Vault contents or document history.
            </p>
          </>
        )}
        {released && (
          <>
            <p>
              {released.grant.mode === "public" ? "Published read-only" : "Link created"} ·{" "}
              {expiryLabel(released.grant.expiresAt)}
            </p>
            {released.secretUnavailable ? (
              <p role="status">
                This link was already issued. Its secret cannot be shown again. Close this dialog
                and choose Create replacement.
              </p>
            ) : (
              <>
                <label htmlFor={`${id}-link`}>Keep this link before closing</label>
                <input
                  id={`${id}-link`}
                  readOnly
                  value={released.url}
                  onFocus={(event) => event.target.select()}
                />
                <Button
                  onClick={async () =>
                    setCopyState(
                      (await copySharingText(released.url))
                        ? "Link copied"
                        : "Copy failed. Select the link above and copy it manually.",
                    )
                  }
                >
                  Copy link
                </Button>
              </>
            )}
            {copyState && <p role="status">{copyState}</p>}
          </>
        )}
        <DialogActions>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {released ? "Done" : "Cancel"}
          </Button>
          {!released && preview && (
            <Button
              disabled={
                busy ||
                !preview.artifact.currentHead ||
                (mode === "password" && password.length < 8) ||
                (mode === "public" && !publicConfirmed)
              }
              onClick={() => void release()}
            >
              {busy
                ? "Creating…"
                : mode === "public"
                  ? "Publish read-only artifact"
                  : "Create expiring link"}
            </Button>
          )}
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
