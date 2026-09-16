"use client";
import type {
  SharingArtifact,
  SharingGrant,
  SharingList,
  SharingPreview,
} from "@symplist/contracts";
import { shareGrantChangedEventSchema } from "@symplist/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { SafeMarkdown } from "@/components/markdown/safe-markdown";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ArtifactSurfaceContext } from "@/features/documents/artifact-surface";
import { workspaceRealtimeSource } from "@/features/workspace/realtime";
import { createIdempotencyKey } from "@/lib/api";
import { type SharingApi, sharingApi } from "./api.ts";
import { registerArtifactLinks } from "./controller.ts";
import { ShareDialog } from "./share-dialog.tsx";
import { SnapshotDialog } from "./snapshot-dialog.tsx";
import { expiryLabel, sharingFailure } from "./ui.ts";

const modeName = {
  link: "Link-only",
  password: "Password-protected",
  public: "Public — anyone can read",
} as const;

export function ArtifactsManager({
  taskId,
  headRevision,
  api: injected,
}: ArtifactSurfaceContext & { api?: SharingApi }) {
  const api = useRef(injected ?? sharingApi()).current;
  const [listing, setListing] = useState<SharingList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [share, setShare] = useState<{ artifact: SharingArtifact; replace?: SharingGrant } | null>(
    null,
  );
  const [preview, setPreview] = useState<SharingPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [revoke, setRevoke] = useState<SharingGrant | null>(null);
  const [revoking, setRevoking] = useState(false);
  const generation = useRef(0);
  const previewGeneration = useRef(0);
  const revokeKey = useRef(createIdempotencyKey());
  const mounted = useRef(false);
  const selected = useRef<SharingGrant | null>(null);
  useEffect(() => {
    mounted.current = true;
    const unregister = registerArtifactLinks({
      get canRevoke() {
        return selected.current?.status === "active";
      },
      revoke() {
        if (selected.current?.status !== "active") return;
        revokeKey.current = createIdempotencyKey();
        setRevoke(selected.current);
      },
    });
    return () => {
      mounted.current = false;
      unregister();
    };
  }, []);
  useEffect(() => {
    if (selected.current)
      selected.current = listing?.grants.find((grant) => grant.id === selected.current?.id) ?? null;
  }, [listing]);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.list(taskId);
      if (request === generation.current) setListing(result);
    } catch (error) {
      if (request === generation.current) setError(sharingFailure(error));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [api, taskId]);
  useEffect(() => {
    // One bounded reload for a burst or reconnect, never one read per remembered grant.
    const source = workspaceRealtimeSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void load();
        }, 750);
    };
    const unsubscribe = source?.subscribeUser({
      onEvent: (frame) => {
        if (frame.type !== "share_grant.changed") return;
        const parsed = shareGrantChangedEventSchema.safeParse(frame.data);
        if (parsed.success && parsed.data.taskId === taskId) refresh();
      },
      onSnapshot: refresh,
    });
    return () => {
      unsubscribe?.();
      clearTimeout(timer);
    };
  }, [load, taskId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      previewGeneration.current += 1;
    };
  }, [load]);
  async function openPreview(id: string) {
    const token = ++previewGeneration.current;
    setPreviewBusy(true);
    setError(null);
    try {
      const result = await api.preview(id);
      if (token === previewGeneration.current) setPreview(result);
    } catch (error) {
      if (token === previewGeneration.current) setError(sharingFailure(error));
    } finally {
      if (token === previewGeneration.current) setPreviewBusy(false);
    }
  }
  async function more() {
    if (!listing?.hasMore || loading) return;
    const token = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.list(taskId, {
        beforeArtifact: listing.nextArtifact ?? "end",
        beforeGrant: listing.nextGrant ?? "end",
      });
      if (token === generation.current)
        setListing({
          ...page,
          artifacts: [
            ...new Map(
              [...listing.artifacts, ...page.artifacts].map((item) => [item.id, item]),
            ).values(),
          ],
          grants: [
            ...new Map([...listing.grants, ...page.grants].map((item) => [item.id, item])).values(),
          ],
        });
    } catch (cause) {
      if (token === generation.current) setError(sharingFailure(cause));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }
  async function revokeGrant() {
    if (!revoke || revoking) return;
    setRevoking(true);
    setError(null);
    try {
      await api.revoke(revoke.artifactId, revoke.id, revokeKey.current);
      if (!mounted.current) return;
      setRevoke(null);
      await load();
    } catch (error) {
      if (mounted.current) setError(sharingFailure(error));
    } finally {
      if (mounted.current) setRevoking(false);
    }
  }
  return (
    <div className="sym-artifacts-manager">
      <div className="sym-sharing-buttons">
        <Button disabled={!headRevision} onClick={() => setSnapshotOpen(true)}>
          New snapshot
        </Button>
        <Link className="sym-doc-link" href={`/tasks/${taskId}/handoff`}>
          Prepare handoff
        </Link>
        <Button variant="ghost" disabled={loading} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {loading && !listing && <p role="status">Loading snapshots and links…</p>}
      {error && (
        <p className="sym-sharing-error" role="alert">
          {error}
        </p>
      )}
      {listing?.artifacts.length === 0 && (
        <div className="sym-sharing-empty">
          <h2>No snapshots or links yet</h2>
          <p>
            Capture a saved page or selected sections, then review exactly what someone else will
            see. Nothing is shared just by opening this screen.
          </p>
        </div>
      )}
      {previewBusy && <p role="status">Opening snapshot…</p>}
      {listing?.artifacts.map((artifact) => (
        <section key={artifact.id} className="sym-artifact-row" aria-label={artifact.title}>
          <div className="sym-artifact-heading">
            <div>
              <h2>{artifact.title}</h2>
              <p className="sym-sharing-meta">
                {artifact.kind === "handoff" ? "Handoff prompt" : "Document snapshot"} · Version{" "}
                {artifact.sourceRevision.slice(0, 8)} · {expiryLabel(artifact.createdAt)}
              </p>
            </div>
            <div className="sym-sharing-buttons">
              <Button variant="secondary" onClick={() => void openPreview(artifact.id)}>
                Preview
              </Button>
              <Button variant="secondary" onClick={() => setShare({ artifact })}>
                Share
              </Button>
            </div>
          </div>
          {artifact.currentHead && artifact.currentHead !== artifact.sourceRevision && (
            <p className="sym-sharing-meta">
              The private page has a newer version. To publish it, create a new snapshot and link.
            </p>
          )}
          <ul className="sym-grants-list">
            {listing.grants
              .filter((grant) => grant.artifactId === artifact.id)
              .map((grant) => (
                <li
                  key={grant.id}
                  onFocusCapture={() => {
                    selected.current = grant;
                  }}
                >
                  <div>
                    <strong>{modeName[grant.mode]}</strong>
                    <span className={`sym-grant-state sym-grant-${grant.status}`}>
                      {grant.status === "disabled" ? "Disabled after access changed" : grant.status}
                    </span>
                    <p className="sym-sharing-meta">
                      {grant.expiresAt
                        ? `Expires ${expiryLabel(grant.expiresAt)}`
                        : "Until revoked"}
                    </p>
                  </div>
                  <div className="sym-sharing-buttons">
                    <Button variant="ghost" onClick={() => setShare({ artifact, replace: grant })}>
                      Create replacement
                    </Button>
                    {grant.status === "active" && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          revokeKey.current = createIdempotencyKey();
                          setRevoke(grant);
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
          {!listing.grants.some((grant) => grant.artifactId === artifact.id) && (
            <p className="sym-sharing-meta">Private snapshot · no shared links</p>
          )}
        </section>
      ))}
      {listing?.hasMore && (
        <Button variant="secondary" disabled={loading} onClick={() => void more()}>
          {loading ? "Loading…" : "Load older snapshots and links"}
        </Button>
      )}
      {listing && listing.grants.length > 0 && (
        <p className="sym-sharing-meta">
          Links are shown only once. To copy again, review a replacement. Each grant is managed
          independently.
        </p>
      )}
      {snapshotOpen && (
        <SnapshotDialog
          taskId={taskId}
          api={api}
          onClose={() => setSnapshotOpen(false)}
          onCreated={(artifact) => {
            setSnapshotOpen(false);
            void load();
            setShare({ artifact });
          }}
        />
      )}
      {share && (
        <ShareDialog
          key={`${share.artifact.id}:${share.replace?.id ?? "new"}`}
          artifactId={share.artifact.id}
          api={api}
          {...(share.replace ? { replace: share.replace } : {})}
          onClose={() => setShare(null)}
          onReleased={() => void load()}
        />
      )}
      {preview && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
        >
          <DialogContent className="sym-share-dialog">
            <DialogTitle>{preview.artifact.title}</DialogTitle>
            <div className="sym-sharing-preview">
              <SafeMarkdown source={preview.markdown} />
            </div>
            <DialogActions>
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Close
              </Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog
        open={Boolean(revoke)}
        onOpenChange={(open) => {
          if (!open && !revoking) setRevoke(null);
        }}
        title="Revoke this link?"
        description="Future reads will stop immediately. Copies already downloaded or fetched cannot be recalled. Other links to this snapshot stay unchanged."
        confirmLabel="Revoke link"
        busy={revoking}
        onConfirm={() => void revokeGrant()}
      >
        {error && revoke && (
          <p role="alert" className="sym-sharing-error">
            {error}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
